import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Connectors signed in through Vercel Connect: one grant per workspace, asked
 * for under the workspace's subject; the token is fetched on every use and
 * never stored; signing in comes back through the same callback as OAuth, and
 * signing out ends the grant at Connect. Connect and the MCP server are stand-ins.
 */

const granted = new Set<string>();
const revoked: string[] = [];
const started: { connector: string; subject: unknown; callbackUrl?: string }[] = [];

vi.mock("@vercel/connect", () => ({
  getTokenResponse: vi.fn(async (connector: string, params: { subject: { id: string } }) => {
    if (!granted.has(`${connector}|${params.subject.id}`)) throw Object.assign(new Error("User authorization required"), { code: "user_authorization_required" });
    return { token: `tok-${params.subject.id}`, expiresAt: Date.now() + 3_600_000 };
  }),
  startAuthorization: vi.fn(async (connector: string, params: { subject: unknown }, options: { callbackUrl?: string }) => {
    started.push({ connector, subject: params.subject, ...(options.callbackUrl === undefined ? {} : { callbackUrl: options.callbackUrl }) });
    return { url: "https://connect.vercel.com/authorize/sca_test", request: "r", verifier: "v" };
  }),
  revokeToken: vi.fn(async (connector: string, params: { subject: { id: string } }) => {
    revoked.push(`${connector}|${params.subject.id}`);
    granted.delete(`${connector}|${params.subject.id}`);
  }),
}));

const TOOLS = ["list_issues", "save_issue"];
const seenAuth: (string | null)[] = [];

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv("BOT_STORE", "memory");
  vi.stubEnv("BOT_COMPUTER_KEY", "k".repeat(40));
  granted.clear();
  revoked.length = 0;
  started.length = 0;
  seenAuth.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      seenAuth.push(new Headers(init?.headers).get("authorization"));
      const message = JSON.parse(String(init?.body)) as { id?: number; method: string };
      if (message.id === undefined) return new Response(null, { status: 202 });
      const result = message.method === "tools/list" ? { tools: TOOLS.map((name) => ({ name })) } : {};
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }), { headers: { "content-type": "application/json" } });
    }),
  );
});

const LINEAR = "linear/acme-linear";

describe("a Vercel Connect connector", () => {
  it("is saved waiting for a sign-in, with nothing secret in it", async () => {
    const connectors = await import("../agent/lib/connectors");
    const added = await connectors.addConnector("ws1", "owner", { label: "Linear", url: "https://mcp.linear.app/mcp", connect: LINEAR, gate: "writes" });
    if (!added.ok) throw new Error(added.error);
    expect(added.connector.auth).toEqual({ kind: "connect", connector: LINEAR, connectedAt: null });
    expect(connectors.needsConnect(added.connector)).toBe(true);
    expect(connectors.publicConnector(added.connector).auth).toMatchObject({ kind: "connect", connected: false, connector: LINEAR });
    expect(await connectors.connectorToken(added.connector)).toBeNull();
  });

  it("refuses a name that is not a Connect connector", async () => {
    const connectors = await import("../agent/lib/connectors");
    const added = await connectors.addConnector("ws1", "owner", { label: "Linear", url: "https://mcp.linear.app/mcp", connect: "https://evil.example" });
    expect(added.ok).toBe(false);
  });

  it("signs the workspace in through Connect, back through the callback, then reads its tools with the fetched token", async () => {
    const connectors = await import("../agent/lib/connectors");
    const added = await connectors.addConnector("ws1", "owner", { label: "Linear", url: "https://mcp.linear.app/mcp", connect: LINEAR });
    if (!added.ok) throw new Error(added.error);
    const start = await connectors.startOAuth("ws1", added.connector.id, "https://bot.example");
    expect(start).toEqual({ ok: true, url: "https://connect.vercel.com/authorize/sca_test" });
    expect(started[0]).toMatchObject({ connector: LINEAR, subject: { type: "user", id: "workspace:ws1", issuer: "urn:eve-bot" } });
    const state = new URL(started[0]!.callbackUrl!).searchParams.get("state")!;
    expect(new URL(started[0]!.callbackUrl!).pathname).toBe(connectors.OAUTH_CALLBACK_PATH);

    granted.add(`${LINEAR}|workspace:ws1`);
    expect(await connectors.completeOAuth(state, null, null)).toEqual({ workspaceId: "ws1", connectorId: added.connector.id, error: null });
    const connected = await connectors.getConnector("ws1", added.connector.id);
    expect(connected?.auth).toMatchObject({ kind: "connect", connector: LINEAR });
    expect(connected !== null && connectors.needsConnect(connected)).toBe(false);
    expect(connected?.check).toMatchObject({ ok: true, tools: TOOLS });
    expect(seenAuth).toContain("Bearer tok-workspace:ws1");
    // Nothing in the stored record is a token.
    expect(JSON.stringify(connected)).not.toContain("tok-");
    // Another workspace has a grant of its own, and none yet.
    const other = await connectors.addConnector("ws2", "owner", { label: "Linear", url: "https://mcp.linear.app/mcp", connect: LINEAR });
    if (!other.ok) throw new Error(other.error);
    expect(other.connector.auth).toMatchObject({ connectedAt: null });
  });

  it("is told the sign-in did not take when Connect still has no grant", async () => {
    const connectors = await import("../agent/lib/connectors");
    const added = await connectors.addConnector("ws1", "owner", { label: "Linear", url: "https://mcp.linear.app/mcp", connect: LINEAR });
    if (!added.ok) throw new Error(added.error);
    await connectors.startOAuth("ws1", added.connector.id, "https://bot.example");
    const state = new URL(started[0]!.callbackUrl!).searchParams.get("state")!;
    expect((await connectors.completeOAuth(state, null, null))?.error).toMatch(/no sign-in/);
  });

  it("signing out ends the grant at Connect and keeps the connector", async () => {
    granted.add(`${LINEAR}|workspace:ws1`);
    const connectors = await import("../agent/lib/connectors");
    const added = await connectors.addConnector("ws1", "owner", { label: "Linear", url: "https://mcp.linear.app/mcp", connect: LINEAR });
    if (!added.ok) throw new Error(added.error);
    expect(connectors.needsConnect(added.connector)).toBe(false);
    expect(await connectors.disconnectOAuth("ws1", added.connector.id)).toBe(true);
    expect(revoked).toEqual([`${LINEAR}|workspace:ws1`]);
    const after = await connectors.getConnector("ws1", added.connector.id);
    expect(after !== null && connectors.needsConnect(after)).toBe(true);
  });

  it("gives eve a token per connection and no key headers, and keeps the approval gate", async () => {
    granted.add(`${LINEAR}|workspace:ws1`);
    const connectors = await import("../agent/lib/connectors");
    const added = await connectors.addConnector("ws1", "owner", { label: "Linear", url: "https://mcp.linear.app/mcp", connect: LINEAR, gate: "writes" });
    if (!added.ok) throw new Error(added.error);
    const { connectorConnection } = await import("../agent/lib/connector-connection");
    const connection = connectorConnection(added.connector, "bot") as unknown as {
      auth: { getToken: () => Promise<{ token: string }> };
      headers: () => Promise<Record<string, string>>;
      approval: { request: (ctx: unknown) => Promise<unknown> };
    };
    expect(await connection.auth.getToken()).toMatchObject({ token: "tok-workspace:ws1" });
    expect(await connection.headers()).toEqual({});
    const ask = (toolName: string) => connection.approval.request({ toolName: `linear__${toolName}`, session: { id: "s1" }, callId: "c1" });
    expect(await ask("list_issues")).toBe("not-applicable");
    expect(await ask("save_issue")).toBe("user-approval");
  });
});
