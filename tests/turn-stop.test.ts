import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A stopped Bot (its job cancelled, or its run halted by the budget) makes no
 * further model call. The check is the teammate's dynamic model (agent.ts via
 * lib/stops.ts): eve evaluates it before every ordinary model call, and an
 * error there fails the turn before the call is made (eve 0.84's dynamic
 * capabilities; see node_modules/eve/docs/guides/dynamic-capabilities.md,
 * "Errors and recovery"). run_job also cancels the Bot's turn when it sees the
 * job stopped.
 *
 * Before eve 0.84 this file drove eve's own turn loop from its dist; that loop
 * no longer evaluates dynamic values itself, so the guarantee is held here at
 * the boundary eve documents: the model is refused for a stopped run, and
 * chosen for a live one. Since 0.84, compaction's summarising call does not
 * evaluate dynamic values, so a stopped run's history can still be compacted
 * once; its next model call is refused.
 */

const WS = "default";
const SESSION = "sess_A";

const auth = { current: { principalId: "runtime", principalType: "runtime", authenticator: "test", attributes: { workspaceId: WS, room: "desk" } }, initiator: null };

/** The Bot's session as its dynamic model reads it, with its job's brief. */
function session() {
  const kept = new Map<string, unknown>();
  return {
    session: { id: SESSION, auth },
    turn: { id: "turn_0", status: "running", input: [] },
    memo: async (key: unknown, fn: (occurrence: unknown) => unknown) => {
      const name = JSON.stringify(key);
      if (!kept.has(name)) kept.set(name, await fn({ idempotencyKey: name, abortSignal: new AbortController().signal }));
      return kept.get(name);
    },
    messages: async () => [{ role: "user", content: "## Job\nid: job_1\neffort: quick\n\nWatch it." }],
  };
}

async function teammateModel(): Promise<(ctx: unknown) => Promise<unknown>> {
  const teammate = ((await import("../agent/subagents/teammate/agent")) as unknown as { default: { model: { evaluate: (ctx: unknown) => Promise<unknown> } } }).default;
  return (ctx) => teammate.model.evaluate(ctx);
}

describe("a stopped teammate turn", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv("BOT_STORE", "memory");
    vi.stubEnv("BOT_MODEL_BASE_URL", "");
    vi.stubEnv("BOT_BUDGET_MONTHLY_USD", "1");
  });

  /** A quick job claimed and admitted under `lease_A`, its run and screen bound to `sess_A`, as `job_brief` leaves them. */
  async function boundRun() {
    const jobs = await import("../agent/lib/jobs");
    const budget = await import("../agent/lib/budget");
    const { bindSession } = await import("../agent/lib/computer/screens");
    const job = await jobs.assignJob({ workspaceId: WS, botId: "bot_1", requestedBy: "op", title: "Watch", brief: "Watch it.", effort: "quick" });
    const claimed = await jobs.claimJob(WS, job.id, { token: "lease_A", forMs: 20 * 60_000, status: "running", kind: "run", countAttempt: true });
    if (!claimed.ok) throw new Error(claimed.reason);
    expect(await budget.admitClaimedRun(WS, claimed.job, "lease_A")).toEqual({ admitted: true });
    expect((await jobs.bindRun(WS, job.id, "lease_A", SESSION)).ok).toBe(true);
    await bindSession({ sessionId: SESSION, workspaceId: WS, botId: "bot_1", jobId: job.id, n: 1 });
    return { jobs, budget, job };
  }

  it("gets its model when nothing stops it", async () => {
    await boundRun();
    const model = await teammateModel();
    expect(await model(session())).toMatchObject({ model: expect.any(String) });
  });

  it("is refused its next model call once its job is cancelled", async () => {
    const { job } = await boundRun();
    const { cancelJobRun } = await import("../agent/lib/cancel");
    const { CANCELLED_STOP_REASON } = await import("../agent/lib/run-stop");
    const model = await teammateModel();
    const ctx = session();
    await model(ctx);
    expect((await cancelJobRun(WS, job.id)).ok).toBe(true);
    await expect(model(ctx)).rejects.toThrow(CANCELLED_STOP_REASON);
  });

  it("is refused its next model call once the budget halted the run", async () => {
    const { budget } = await boundRun();
    const { BUDGET_HALT_REASON } = await import("../agent/lib/budget");
    const hook = (await import("../agent/subagents/teammate/hooks/usage")).default as unknown as { events: Record<string, (event: never, ctx: never) => Promise<void>> };
    const { emptySessionView } = await import("eve/events");
    const model = await teammateModel();
    const ctx = session();
    await model(ctx);
    // One model run that spent past the run's reservation with nothing left in the workspace.
    const spent = { type: "usage.recorded", data: { kind: "model", owner: { runId: "run_1" }, usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 1.2 } } };
    await hook.events["usage.recorded"]!(spent as never, { session: { id: SESSION, auth, parent: { sessionId: "sess_hq" } }, view: emptySessionView(), position: { line: 3, index: 0 } } as never);
    expect(await budget.runHalted(WS, "lease_A")).toBe(true);
    await expect(model(ctx)).rejects.toThrow(BUDGET_HALT_REASON);
  });
});
