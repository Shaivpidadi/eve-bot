import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Confirming guessed reads in bulk: the upgrade path for connectors stored
 * before HQ needed reviewed reads. Only guessed reads move, writes stay
 * writes, the permission version moves once, the route wants the same login
 * as the policy PATCH, and HQ is offered the confirmed reads afterwards. The
 * store is the in-memory one; the MCP server is a stand-in.
 */

vi.mock("../agent/lib/computer-backup", () => ({
  ensureComputerRestored: vi.fn(async () => undefined),
  checkpointComputer: vi.fn(async () => undefined),
}));
vi.mock("../agent/subagents/teammate/lib/browser", () => ({ bindScreen: vi.fn(async () => undefined) }));
vi.mock("../agent/lib/computer/shell", async (original) => ({
  ...(await original<typeof import("../agent/lib/computer/shell")>()),
  stopRunCommands: vi.fn(async () => 0),
}));

const WORKSPACE = "default";
const TOOLS = ["get_issue", "list_issues", "search_code", "create_issue", "run_query", "get_query_result"];

type Route = { method: string; path: string; handler: (request: Request, args: unknown) => Promise<Response> };

describe("confirming guessed reads", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv("BOT_STORE", "memory");
    vi.stubEnv("BOT_COMPUTER_KEY", "k".repeat(40));
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("BOT_CONSOLE_TOKEN", "");
    vi.stubEnv("BOT_CONSOLE_TOKENS", "");
    vi.stubEnv("BOT_CONSOLE_OPEN", "");
    vi.stubEnv("NODE_ENV", "test");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const message = JSON.parse(String(init?.body)) as { id?: number; method: string };
        if (message.id === undefined) return new Response(null, { status: 202 });
        const result = message.method === "tools/list" ? { tools: TOOLS.map((name) => ({ name })) } : {};
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }), { headers: { "content-type": "application/json" } });
      }),
    );
  });

  /** A custom connector as an install from before this version has it: every read a guess. */
  async function legacy() {
    const connectors = await import("../agent/lib/connectors");
    const added = await connectors.addConnector(WORKSPACE, "owner", { label: "Tracker", url: "https://mcp.example/mcp", key: { kind: "bearer", secret: "key" }, gate: "writes" });
    if (!added.ok) throw new Error(added.error);
    const { updateDoc } = await import("../agent/lib/store");
    // Stored before `reviewed` existed.
    const stored = await updateDoc(`connectors/${WORKSPACE}/${added.connector.id}.json`, (current: Record<string, unknown> | null) => {
      if (current === null) return null;
      const { reviewed: _reviewed, ...rest } = current;
      return rest;
    });
    return { connectors, connector: stored as unknown as Awaited<ReturnType<typeof connectors.getConnector>> & object };
  }

  const routeOf = async (method: string, path: string): Promise<Route> => {
    const ops = (await import("../agent/channels/ops")).default as unknown as { routes: Route[] };
    const route = ops.routes.find((candidate) => candidate.method === method && candidate.path === path);
    expect(route).toBeDefined();
    return route!;
  };

  it("sees only the name-guessed reads as waiting, and HQ none of them yet", async () => {
    const { connectors, connector } = await legacy();
    const { guessedReads } = await import("../agent/lib/catalog");
    expect(guessedReads(connector)).toEqual(["get_issue", "list_issues", "search_code"]);
    expect(connectors.allowedTools(connector, { readsOnly: true })).toEqual([]);
  });

  it("confirms every guessed read, keeps writes as writes, and moves the version once", async () => {
    const { connectors, connector } = await legacy();
    const before = connectors.permissionVersion(connector);
    const done = await connectors.confirmGuessedReads(WORKSPACE, connector.id);
    expect(done?.confirmed).toEqual(["get_issue", "list_issues", "search_code"]);
    const after = done!.connector;
    expect(after.reviewed).toEqual(["get_issue", "list_issues", "search_code"]);
    expect(after.policy).toMatchObject({ create_issue: "write", run_query: "write", get_query_result: "write" });
    expect(connectors.permissionVersion(after)).toBe(before + 1);
    // HQ gets exactly the confirmed reads now.
    expect(connectors.allowedTools(after, { readsOnly: true })).toEqual(["get_issue", "list_issues", "search_code"]);
    // Nothing left to confirm: no write, no version move.
    const again = await connectors.confirmGuessedReads(WORKSPACE, connector.id);
    expect(again?.confirmed).toEqual([]);
    expect(connectors.permissionVersion(again!.connector)).toBe(before + 1);
  });

  it("confirms only the selected guessed reads and skips writes, unknowns, and switched-off tools", async () => {
    const { connectors, connector } = await legacy();
    const off = await connectors.updateConnector(WORKSPACE, connector.id, { tools: { search_code: false } });
    const before = connectors.permissionVersion(off!);
    const done = await connectors.confirmGuessedReads(WORKSPACE, connector.id, ["get_issue", "create_issue", "get_query_result", "search_code", "nope"]);
    expect(done?.confirmed).toEqual(["get_issue"]);
    expect(done?.skipped).toEqual(["create_issue", "get_query_result", "search_code", "nope"]);
    expect(done!.connector.reviewed).toEqual(["get_issue"]);
    expect(done!.connector.policy).toMatchObject({ create_issue: "write", get_query_result: "write" });
    expect(connectors.permissionVersion(done!.connector)).toBe(before + 1);
    expect(connectors.allowedTools(done!.connector, { readsOnly: true })).toEqual(["get_issue"]);
  });

  it("does not touch a tool the operator already marked a change", async () => {
    const { connectors, connector } = await legacy();
    await connectors.updateConnector(WORKSPACE, connector.id, { policy: { list_issues: "write" } });
    const done = await connectors.confirmGuessedReads(WORKSPACE, connector.id, ["list_issues"]);
    expect(done?.confirmed).toEqual([]);
    expect(done!.connector.policy?.list_issues).toBe("write");
    expect(connectors.allowedTools(done!.connector, { readsOnly: true })).toEqual([]);
  });

  it("POST /bot/v1/connectors/:id/reviewed-reads wants the console login, then confirms", async () => {
    vi.stubEnv("BOT_CONSOLE_TOKEN", "top-secret");
    const { connectors, connector } = await legacy();
    const route = await routeOf("POST", "/bot/v1/connectors/:connectorId/reviewed-reads");
    const call = (headers: Record<string, string>, body: unknown) =>
      route.handler(
        new Request(`http://localhost/bot/v1/connectors/${connector.id}/reviewed-reads`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }),
        { params: { connectorId: connector.id } },
      );

    const anonymous = await call({}, { tools: ["get_issue"] });
    expect(anonymous.status).toBe(401);
    const wrong = await call({ authorization: "Bearer guess" }, { tools: ["get_issue"] });
    expect(wrong.status).toBe(401);
    expect((await connectors.getConnector(WORKSPACE, connector.id))?.reviewed ?? []).toEqual([]);

    expect((await call({ authorization: "Bearer top-secret" }, { tools: "get_issue" })).status).toBe(400);
    const ok = await call({ authorization: "Bearer top-secret" }, { tools: ["get_issue", "create_issue"] });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ confirmed: ["get_issue"], skipped: ["create_issue"], connector: { reviewed: ["get_issue"] } });
    const missing = await route.handler(
      new Request("http://localhost/bot/v1/connectors/conn_x/reviewed-reads", { method: "POST", headers: { authorization: "Bearer top-secret" } }),
      { params: { connectorId: "conn_x" } },
    );
    expect(missing.status).toBe(404);
  });

  it("HQ's connection offers the confirmed reads afterwards", async () => {
    const { connectors, connector } = await legacy();
    const { connectorConnection } = await import("../agent/lib/connector-connection");
    const allowOf = (def: unknown) => (def as { tools?: { allow?: string[] } } | null)?.tools?.allow ?? [];
    // Before: no reviewed read, so HQ has no connection to it at all.
    expect(connectorConnection((await connectors.getConnector(WORKSPACE, connector.id))!, "hq")).toBeNull();
    await connectors.confirmGuessedReads(WORKSPACE, connector.id, ["list_issues"]);
    expect(allowOf(connectorConnection((await connectors.getConnector(WORKSPACE, connector.id))!, "hq"))).toEqual(["list_issues"]);
  });
});
