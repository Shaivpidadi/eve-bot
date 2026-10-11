import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ApprovalContext, ApprovalStatus } from "eve/tools/approval";

/**
 * A Bot's connector calls stop with its run: once the job is cancelled or a
 * newer run takes it over, the connection's approval policy refuses every
 * call, reads included, before the connector's own rules are consulted. The
 * store is the in-memory one; the MCP server is a stand-in.
 */

vi.mock("../agent/lib/computer-backup", () => ({
  ensureComputerRestored: vi.fn(async () => undefined),
  checkpointComputer: vi.fn(async () => undefined),
}));
vi.mock("../agent/subagents/teammate/lib/browser", () => ({
  bindScreen: async (ctx: { session: { id: string; auth: never } }, botId: string, jobId: string) => {
    const { bindSession } = await import("../agent/lib/computer/screens");
    const { operator } = await import("../agent/lib/session");
    return bindSession({ sessionId: ctx.session.id, workspaceId: operator(ctx).workspaceId, botId, jobId, n: 1 });
  },
}));

const WORKSPACE = "default";

const sessionFor = (sessionId: string) => ({
  id: sessionId,
  auth: {
    current: {
      principalId: "runtime",
      principalType: "runtime",
      authenticator: "test",
      attributes: { workspaceId: WORKSPACE, room: "desk" },
    },
    initiator: null,
  },
  turn: { id: "t", sequence: 1 },
});

type Exec = { execute: (input: unknown, ctx: never) => Promise<Record<string, unknown>> };
type Def = { approval: (ctx: ApprovalContext) => Promise<ApprovalStatus> };

const denied = (status: ApprovalStatus): string | null =>
  typeof status === "object" && status !== null && status.type === "denied" ? (status.reason ?? "") : null;

/** Asks the connection's approval policy about one call from `sessionId`, as eve does before running it. */
const ask = (def: Def, tool: string, sessionId: string) =>
  def.approval({
    toolName: `tracker__${tool}`,
    approvedTools: new Set(),
    callId: "call_1",
    session: sessionFor(sessionId),
  } as unknown as ApprovalContext);

describe("a Bot's connector calls follow its run", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("BOT_STORE", "memory");
    vi.stubEnv("BOT_COMPUTER_KEY", "k".repeat(40));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const message = JSON.parse(String(init?.body)) as { id?: number; method: string };
        if (message.id === undefined) return new Response(null, { status: 202 });
        const result = message.method === "tools/list" ? { tools: [{ name: "get_issue" }, { name: "create_issue" }] } : {};
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }), {
          headers: { "content-type": "application/json" },
        });
      }),
    );
  });

  /** A connector, the Bot's connection to it, and a job claimed by `lease_A` and bound to `sess_A`. */
  async function working() {
    const connectors = await import("../agent/lib/connectors");
    const { connectorConnection } = await import("../agent/lib/connector-connection");
    const { guardSideEffect } = await import("../agent/lib/run-guard");
    const jobs = await import("../agent/lib/jobs");
    const added = await connectors.addConnector(WORKSPACE, "owner", {
      label: "Tracker",
      url: "https://mcp.example/mcp",
      key: { kind: "bearer", secret: "key-one" },
      gate: "writes",
    });
    if (!added.ok) throw new Error(added.error);
    const def = connectorConnection(added.connector, "bot", { checkCaller: guardSideEffect }) as unknown as Def;

    const job = await jobs.assignJob({
      workspaceId: WORKSPACE,
      botId: "bot_1",
      requestedBy: "operator",
      title: "Triage issues",
      brief: "Read the new issues.",
    });
    const claimed = await jobs.claimJob(WORKSPACE, job.id, {
      token: "lease_A",
      forMs: 20 * 60_000,
      status: "running",
      kind: "run",
      countAttempt: true,
    });
    expect(claimed.ok).toBe(true);
    const jobBrief = (await import("../agent/subagents/teammate/tools/job_brief")).default as unknown as Exec;
    const brief = await jobBrief.execute({ jobId: job.id, runToken: "lease_A" }, { session: sessionFor("sess_A") } as never);
    expect(brief.found).toBe(true);
    return { def, jobs, job, connector: added.connector };
  }

  it("lets the current run through to the connector's own rules", async () => {
    const { def } = await working();
    expect(await ask(def, "get_issue", "sess_A")).toBe("not-applicable");
    expect(await ask(def, "create_issue", "sess_A")).toBe("user-approval");
  });

  it("refuses every call once the job is cancelled, reads included", async () => {
    const { def, job } = await working();
    const { cancelJobRun } = await import("../agent/lib/cancel");
    expect((await cancelJobRun(WORKSPACE, job.id)).ok).toBe(true);
    expect(denied(await ask(def, "get_issue", "sess_A"))).toMatch(/cancel/i);
    expect(denied(await ask(def, "create_issue", "sess_A"))).toMatch(/cancel/i);
  });

  it("refuses the old run once a newer run takes the job over", async () => {
    const { def, jobs, job } = await working();
    // Run A's lease lapses and run B claims the job.
    const { updateDoc } = await import("../agent/lib/store");
    await updateDoc(`jobs/${WORKSPACE}/${job.id}.json`, (current: Record<string, unknown> | null) =>
      current === null ? null : { ...current, lease: { token: "lease_A", kind: "run", until: new Date(0).toISOString() } },
    );
    const claimed = await jobs.claimJob(WORKSPACE, job.id, { token: "lease_B", forMs: 60_000, status: "running", kind: "run" });
    expect(claimed.ok).toBe(true);
    expect(denied(await ask(def, "get_issue", "sess_A"))).not.toBeNull();
  });

  it("refuses a session that never read its job brief", async () => {
    const { def } = await working();
    expect(denied(await ask(def, "get_issue", "sess_stranger"))).toMatch(/job_brief/);
  });

  it("leaves a connection without a caller check (HQ) to the connector's rules alone", async () => {
    const { connector } = await working();
    const { connectorConnection } = await import("../agent/lib/connector-connection");
    const def = connectorConnection(connector, "bot") as unknown as Def;
    expect(await ask(def, "get_issue", "sess_stranger")).toBe("not-applicable");
  });
});
