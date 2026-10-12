import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ApprovalContext, ApprovalResponseContext, ApprovalResponseDecision, ApprovalStatus } from "eve/tools/approval";

/**
 * Settings changed on the Connectors page while a session is running: every
 * later call obeys the change. The "session" here is the connection eve was
 * handed when it started; its hooks are called the way eve calls them.
 */

const WORKSPACE = "ws_test";
let tools: string[] = [];
let keysSeen: string[] = [];

/** A tiny MCP server: answers initialize and tools/list, and records the key it was sent. */
function fakeMcp() {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    keysSeen.push(headers.get("authorization") ?? "");
    const message = JSON.parse(String(init?.body)) as { id?: number; method: string };
    if (message.id === undefined) return new Response(null, { status: 202 });
    const result = message.method === "tools/list" ? { tools: tools.map((name) => ({ name })) } : {};
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }), { headers: { "content-type": "application/json" } });
  });
}

async function load() {
  const connectors = await import("../agent/lib/connectors");
  const connection = await import("../agent/lib/connector-connection");
  const store = await import("../agent/lib/store");
  return { ...connectors, ...connection, store };
}

type Def = NonNullable<ReturnType<Awaited<ReturnType<typeof load>>["connectorConnection"]>>;

type Approval = {
  request: (ctx: ApprovalContext) => Promise<ApprovalStatus>;
  response: (ctx: ApprovalResponseContext) => Promise<ApprovalResponseDecision>;
};
const approvalOf = (def: Def) => def.approval as unknown as Approval;
const session = (id: string) => ({ id, auth: { current: null, initiator: null }, turn: { id: "t", sequence: 1 } });

/** Asks the connection's approval policy about one call, as eve does before running it. */
async function ask(def: Def, name: string, tool: string, sessionId = "sess_1"): Promise<ApprovalStatus> {
  return approvalOf(def).request({ toolName: `${name}__${tool}`, approvedTools: new Set(), callId: "call_1", session: session(sessionId) } as unknown as ApprovalContext);
}

/** A person approves one call, as eve runs the response policy when they click Approve. A denial runs nothing. */
async function approve(def: Def, name: string, tool: string, sessionId = "sess_1"): Promise<ApprovalResponseDecision> {
  return approvalOf(def).response({
    request: { callId: "call_1", requestId: "req_1", toolName: `${name}__${tool}` },
    response: { decision: "approve" },
    responder: { principalId: "owner" },
    session: session(sessionId),
  } as unknown as ApprovalResponseContext);
}

const headersOf = (def: Def) => (def.headers as () => Promise<Record<string, string>>)();
const denied = (status: ApprovalStatus) => typeof status === "object" && status !== null && status.type === "denied";

describe("live connector permissions", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("BOT_STORE", "memory");
    vi.stubEnv("BOT_COMPUTER_KEY", "k".repeat(40));
    vi.stubGlobal("fetch", fakeMcp());
    tools = ["get_issue", "list_issues", "create_issue", "obliterate_everything"];
    keysSeen = [];
  });

  async function added(gate: "none" | "writes" | "all" = "writes") {
    const lib = await load();
    const result = await lib.addConnector(WORKSPACE, "owner", { label: "Tracker", url: "https://mcp.example/mcp", key: { kind: "bearer", secret: "key-one" }, gate });
    if (!result.ok) throw new Error(result.error);
    return { lib, connector: result.connector };
  }

  it("stops a running session's calls once the connector is switched off", async () => {
    const { lib, connector } = await added();
    const def = lib.connectorConnection(connector, "bot")!;
    expect(await ask(def, connector.name, "get_issue")).toBe("not-applicable");
    expect(await headersOf(def)).toEqual({ authorization: "Bearer key-one" });

    await lib.updateConnector(WORKSPACE, connector.id, { enabled: false });
    expect(denied(await ask(def, connector.name, "get_issue"))).toBe(true);
    await expect(headersOf(def)).rejects.toThrow();
  });

  it("stops a tool switched off mid-session, and leaves the others alone", async () => {
    const { lib, connector } = await added();
    const def = lib.connectorConnection(connector, "bot")!;
    await lib.updateConnector(WORKSPACE, connector.id, { tools: { list_issues: false } });
    expect(denied(await ask(def, connector.name, "list_issues"))).toBe(true);
    expect(await ask(def, connector.name, "get_issue")).toBe("not-applicable");
  });

  it("always passes the checked allow-list, and never runs a tool the server grew since", async () => {
    const { lib, connector } = await added();
    const def = lib.connectorConnection(connector, "bot")!;
    expect(def.tools).toEqual({ allow: tools });
    expect(denied(await ask(def, connector.name, "brand_new_tool"))).toBe(true);
  });

  it("asks before a tool re-marked as a change, under the writes gate", async () => {
    const { lib, connector } = await added("writes");
    const def = lib.connectorConnection(connector, "bot")!;
    expect(await ask(def, connector.name, "get_issue")).toBe("not-applicable");
    // An unfamiliar name needs approval by default.
    expect(await ask(def, connector.name, "obliterate_everything")).toBe("user-approval");

    await lib.updateConnector(WORKSPACE, connector.id, { policy: { get_issue: "write" } });
    expect(await ask(def, connector.name, "get_issue")).toBe("user-approval");
    await lib.updateConnector(WORKSPACE, connector.id, { gate: "none" });
    expect(await ask(def, connector.name, "get_issue")).toBe("not-applicable");
  });

  it("sends a rotated key, read from the store rather than the session", async () => {
    const { lib, connector } = await added();
    const def = lib.connectorConnection(connector, "bot")!;
    const rotated = await lib.replaceKey(WORKSPACE, connector.id, { secret: "key-two" });
    expect(rotated.ok).toBe(true);
    expect(await headersOf(def)).toEqual({ authorization: "Bearer key-two" });
  });

  it("gives a removed connector no credentials and no calls", async () => {
    const { lib, connector } = await added();
    const def = lib.connectorConnection(connector, "bot")!;
    await lib.removeConnector(WORKSPACE, connector.id);
    expect(denied(await ask(def, connector.name, "get_issue"))).toBe(true);
    await expect(headersOf(def)).rejects.toThrow();
  });

  it("does not fall back to the old record when an OAuth connector is removed", async () => {
    const lib = await load();
    const oauth = {
      id: "conn_oauth",
      workspaceId: WORKSPACE,
      name: "tracker",
      label: "Tracker",
      catalog: null,
      url: "https://mcp.example/mcp",
      description: "Tracker",
      auth: { kind: "oauth", metadata: { issuer: "https://mcp.example" }, client: null, sealed: null, connectedAt: null },
      enabled: true,
      gate: "writes",
      policy: { get_issue: "read" },
      check: { ok: true, at: "2026-10-01T00:00:00.000Z", tools: ["get_issue"], error: null },
      createdAt: "2026-10-01T00:00:00.000Z",
      createdBy: "owner",
    } as unknown as Parameters<typeof lib.connectorConnection>[0];
    await lib.store.writeDoc(`connectors/${WORKSPACE}/${oauth.id}.json`, oauth);
    const def = lib.connectorConnection(oauth, "bot")!;
    const getToken = (def.auth as { getToken: () => Promise<unknown> }).getToken;
    // Present but not signed in: ask the person to connect.
    await expect(getToken()).rejects.toMatchObject({ name: "ConnectionAuthorizationRequiredError" });

    await lib.removeConnector(WORKSPACE, oauth.id);
    // Gone: a terminal failure, not a prompt to sign in to something deleted.
    await expect(getToken()).rejects.toMatchObject({ name: "ConnectionAuthorizationFailedError", reason: "connector_removed", retryable: false });
    expect(denied(await ask(def, oauth.name, "get_issue"))).toBe(true);
  });

  it("gives HQ only reviewed reads, and follows a review made mid-session", async () => {
    const { lib, connector } = await added();
    // Nothing reviewed yet: HQ gets no connection at all.
    expect(lib.connectorConnection(connector, "hq")).toBeNull();

    const reviewed = await lib.updateConnector(WORKSPACE, connector.id, { policy: { get_issue: "read" } });
    const def = lib.connectorConnection(reviewed!, "hq")!;
    expect(def.tools).toEqual({ allow: ["get_issue"] });
    expect(await ask(def, connector.name, "get_issue")).toBe("not-applicable");
    // A guessed read, an unfamiliar name, and a write: all refused for HQ.
    for (const tool of ["list_issues", "obliterate_everything", "create_issue"]) expect(denied(await ask(def, connector.name, tool)), tool).toBe(true);

    await lib.updateConnector(WORKSPACE, connector.id, { policy: { get_issue: "write" } });
    expect(denied(await ask(def, connector.name, "get_issue"))).toBe(true);
  });

  it("does not reuse a once-per-job approval given under older settings", async () => {
    const { lib, connector } = await added("all");
    const def = lib.connectorConnection(connector, "bot")!;
    expect(await ask(def, connector.name, "get_issue")).toBe("user-approval");
    expect(await approve(def, connector.name, "get_issue")).toEqual({ status: "allowed" });
    expect(await ask(def, connector.name, "get_issue")).toBe("not-applicable");

    await lib.updateConnector(WORKSPACE, connector.id, { tools: { list_issues: false } });
    // Settings changed since the approval: ask again, and keep asking until a person says yes.
    expect(await ask(def, connector.name, "get_issue")).toBe("user-approval");
    await approve(def, connector.name, "get_issue");
    expect(await ask(def, connector.name, "get_issue")).toBe("not-applicable");
  });

  it("does not count a denied re-ask as an approval", async () => {
    const { lib, connector } = await added("all");
    const def = lib.connectorConnection(connector, "bot")!;
    expect(await ask(def, connector.name, "create_issue")).toBe("user-approval");
    await approve(def, connector.name, "create_issue");
    expect(await ask(def, connector.name, "create_issue")).toBe("not-applicable");

    await lib.updateConnector(WORKSPACE, connector.id, { policy: { create_issue: "write" } });
    // The re-ask is sent; the person clicks Deny, which runs no response policy.
    expect(await ask(def, connector.name, "create_issue")).toBe("user-approval");
    // The next call is asked again rather than run on the old approval.
    expect(await ask(def, connector.name, "create_issue")).toBe("user-approval");
    expect(await ask(def, connector.name, "create_issue")).toBe("user-approval");
  });

  it("asks again after a settings change, on a later turn's rebuilt connection too", async () => {
    const { lib, connector } = await added("all");
    const turn1 = lib.connectorConnection(connector, "bot")!;
    await ask(turn1, connector.name, "get_issue");
    await approve(turn1, connector.name, "get_issue");

    await lib.updateConnector(WORKSPACE, connector.id, { gate: "all", tools: { list_issues: false } });
    // eve resolves the connection set again on the next turn, from the changed record.
    const turn2 = lib.connectorConnection((await lib.getConnector(WORKSPACE, connector.id))!, "bot")!;
    expect(await ask(turn2, connector.name, "get_issue")).toBe("user-approval");
    expect(await ask(turn1, connector.name, "get_issue")).toBe("user-approval");
    await approve(turn2, connector.name, "get_issue");
    expect(await ask(turn2, connector.name, "get_issue")).toBe("not-applicable");
  });

  it("keeps an approval under unchanged settings across turns, for that session only", async () => {
    const { lib, connector } = await added("all");
    const turn1 = lib.connectorConnection(connector, "bot")!;
    await ask(turn1, connector.name, "get_issue", "sess_1");
    await approve(turn1, connector.name, "get_issue", "sess_1");
    const turn2 = lib.connectorConnection((await lib.getConnector(WORKSPACE, connector.id))!, "bot")!;
    expect(await ask(turn2, connector.name, "get_issue", "sess_1")).toBe("not-applicable");
    // Per tool, and per session: another job's Bot is asked for itself.
    expect(await ask(turn2, connector.name, "create_issue", "sess_1")).toBe("user-approval");
    expect(await ask(turn2, connector.name, "get_issue", "sess_2")).toBe("user-approval");
  });

  it("rejects an approval for a connector removed while it waited, recording nothing", async () => {
    const { lib, connector } = await added("all");
    const def = lib.connectorConnection(connector, "bot")!;
    expect(await ask(def, connector.name, "get_issue")).toBe("user-approval");
    await lib.removeConnector(WORKSPACE, connector.id);
    expect(await approve(def, connector.name, "get_issue")).toMatchObject({ status: "rejected", reason: expect.stringMatching(/removed/) });
    expect(await lib.approvedVersion("sess_1", connector.id, "get_issue")).toBeNull();
  });

  it("rejects an approval for a tool switched off while it waited, so the call never runs", async () => {
    const { lib, connector } = await added("writes");
    const def = lib.connectorConnection(connector, "bot")!;
    expect(await ask(def, connector.name, "create_issue")).toBe("user-approval");
    await lib.updateConnector(WORKSPACE, connector.id, { tools: { create_issue: false } });
    expect(await approve(def, connector.name, "create_issue")).toMatchObject({ status: "rejected", reason: expect.stringMatching(/deny this request/) });
  });

  it("records an approval under the settings it was asked under, not the ones in force when it lands", async () => {
    const { lib, connector } = await added("all");
    const def = lib.connectorConnection(connector, "bot")!;
    expect(await ask(def, connector.name, "get_issue")).toBe("user-approval");
    // The settings change while the prompt waits; the person approves afterwards.
    await lib.updateConnector(WORKSPACE, connector.id, { tools: { list_issues: false } });
    expect(await approve(def, connector.name, "get_issue")).toEqual({ status: "allowed" });
    // That call runs, but the approval does not carry over to the new settings.
    expect(await lib.approvedVersion("sess_1", connector.id, "get_issue")).toBeNull();
    expect(await ask(def, connector.name, "get_issue")).toBe("user-approval");
    expect(await approve(def, connector.name, "get_issue")).toEqual({ status: "allowed" });
    expect(await ask(def, connector.name, "get_issue")).toBe("not-applicable");
  });

  it("bumps the permission version on every settings change, and keeps old records loading", async () => {
    const { lib, connector } = await added();
    const versions = [lib.permissionVersion(connector)];
    const changes = [
      () => lib.updateConnector(WORKSPACE, connector.id, { enabled: false }),
      () => lib.updateConnector(WORKSPACE, connector.id, { tools: { get_issue: false } }),
      () => lib.updateConnector(WORKSPACE, connector.id, { policy: { get_issue: "write" } }),
      () => lib.updateConnector(WORKSPACE, connector.id, { gate: "all" }),
      async () => {
        const replaced = await lib.replaceKey(WORKSPACE, connector.id, { secret: "key-three" });
        return replaced.ok ? replaced.connector : null;
      },
    ];
    for (const change of changes) versions.push(lib.permissionVersion((await change())!));
    expect(new Set(versions).size).toBe(versions.length);
    // A description is not a permission.
    const described = await lib.updateConnector(WORKSPACE, connector.id, { description: "New words" });
    expect(lib.permissionVersion(described!)).toBe(versions.at(-1));
    // A record from before versions and reviews existed.
    expect(lib.permissionVersion({})).toBe(0);
  });
});
