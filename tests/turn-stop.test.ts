import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { z } from "zod";

/**
 * A Bot's turn really stops before the model call when a teammate hook throws
 * on `step.started`: the budget halt (hooks/usage.ts) relies on it.
 *
 * eve documents that a throwing `step.started` hook fails the turn; this holds
 * eve to it with eve's own turn loop rather than a model of it. The harness
 * (`createToolLoopHarness`), the hook dispatcher (`dispatchStreamEventHooks`,
 * which wraps a `step.started` throw as a `BoundaryHookError`) and the context
 * container are eve's, loaded from its dist; the model is the AI SDK's mock,
 * so nothing is paid for. The hooks are the teammate's real modules over the
 * in-memory store. Mode is `conversation`, the mode eve runs a subagent child
 * in (subagents/tool.js). If an eve upgrade moves these internals, this file
 * fails to load, which is the point: the guarantee must be re-checked.
 */

const WS = "default";
const SESSION = "sess_A";

const eve = (path: string) => import(/* @vite-ignore */ new URL(`../node_modules/eve/dist/src/${path}`, import.meta.url).href);

type HookModule = { default: { events: Record<string, (event: never, ctx: never) => unknown> } };
type Event = { type: string; data?: Record<string, unknown> };

/** The end of one model answer; `costUsd` is reported the way AI Gateway reports it. */
const finish = (unified: "stop" | "tool-calls", costUsd?: number) => ({
  type: "finish" as const,
  finishReason: { unified, raw: unified },
  usage: { inputTokens: { total: 1000, noCache: 1000, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 100, text: 100, reasoning: 0 } },
  ...(costUsd === undefined ? {} : { providerMetadata: { gateway: { cost: String(costUsd) } } }),
});

/**
 * One Bot turn through eve's harness, with the teammate hooks subscribed the
 * way eve subscribes them. `script` answers each model call in order; `tools`
 * are the Bot's tools for the turn.
 */
async function botTurn(options: {
  script: Array<() => unknown[]>;
  tools?: Map<string, unknown>;
}): Promise<{ modelCalls: number; events: Event[]; settled: { output: unknown; isError?: boolean } | undefined; parked: boolean }> {
  const { createToolLoopHarness } = await eve("harness/tool-loop.js");
  const { dispatchStreamEventHooks } = await eve("context/hook-lifecycle.js");
  const { ContextContainer, contextStorage } = await eve("context/container.js");
  const { SessionKey } = await eve("context/keys.js");
  const { BundleKey } = await eve("runtime/sessions/runtime-context-keys.js");

  const hooks = [((await import("../agent/subagents/teammate/hooks/usage")) as HookModule).default];
  const byType = new Map<string, Array<{ handler: (event: never, ctx: never) => unknown }>>();
  for (const hook of hooks) {
    for (const [type, handler] of Object.entries(hook.events)) byType.set(type, [...(byType.get(type) ?? []), { handler }]);
  }
  const registry = { streamEventsByType: byType, streamEventsWildcard: [] };

  let modelCalls = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      const answer = options.script[modelCalls];
      modelCalls += 1;
      if (answer === undefined) throw new Error("The model was called more often than the test scripted.");
      return { stream: convertArrayToReadableStream(answer() as never[]) };
    },
  });

  const auth = {
    current: { principalId: "runtime", principalType: "runtime", authenticator: "test", attributes: { workspaceId: WS, room: "desk" } },
    initiator: null,
  };
  const ctx = new ContextContainer();
  ctx.set(SessionKey, { sessionId: SESSION, auth, turn: { id: "turn_1", sequence: 0 } });
  ctx.set(BundleKey, { turnAgent: { id: "teammate" }, nodeId: "teammate" });

  const events: Event[] = [];
  const step = createToolLoopHarness({
    mode: "conversation",
    tools: options.tools ?? new Map(),
    resolveModel: async () => model,
    handleEvent: async (event: Event) => {
      events.push(event);
      await dispatchStreamEventHooks({ ctx, registry, event: { ...event, meta: { id: `evt_${events.length}`, at: new Date().toISOString() } } });
    },
  });
  const session = {
    agent: { system: "You are a Bot.", tools: [], modelReference: { id: "mock/model" } },
    // Far above anything here: compaction would make a model call of its own.
    compaction: { recentWindowSize: 10, threshold: 100_000_000 },
    continuationToken: "cont_1",
    history: [],
    sessionId: SESSION,
    state: {},
  };

  const result = await contextStorage.run(ctx, async () => {
    let current = await step(session, { message: "Do the job." });
    // A function is eve's "call this step now": the tool loop continuing.
    while (typeof current.next === "function") current = await current.next(current.session);
    return current;
  });
  return { modelCalls, events, settled: result.settledTurn, parked: result.next === null };
}

const say = (text: string) => () => [
  { type: "stream-start", warnings: [] },
  { type: "text-start", id: "t1" },
  { type: "text-delta", id: "t1", delta: text },
  { type: "text-end", id: "t1" },
  finish("stop"),
];

const callTool = (toolName: string, costUsd?: number) => () => [
  { type: "stream-start", warnings: [] },
  { type: "tool-call", toolCallId: "call_1", toolName, input: "{}" },
  finish("tool-calls", costUsd),
];

/** A Bot tool that does nothing but record that it ran. */
const recordingTool = (name: string, ran: string[], during?: () => Promise<void>) =>
  new Map([
    [
      name,
      {
        name,
        description: "Looks at the page.",
        inputSchema: z.object({}),
        async execute() {
          await during?.();
          ran.push(name);
          return { seen: "a page" };
        },
      },
    ],
  ]);

describe("a teammate turn stopped by a step.started hook", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("BOT_STORE", "memory");
    vi.stubEnv("BOT_BUDGET_MONTHLY_USD", "10");
    // eve's telemetry warns once outside a workflow step; it has no bearing here.
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
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

  it("reaches the model when nothing stops it (the harness here is live)", async () => {
    await boundRun();
    const turn = await botTurn({ script: [say("Working on it.")] });
    expect(turn.modelCalls).toBe(1);
    expect(turn.settled).toEqual({ output: "Working on it." });
    expect(turn.events.map((event) => event.type)).toContain("turn.completed");
  });

  it("makes no model call once the budget halted the run, and fails the turn with the reason", async () => {
    const { budget } = await boundRun();
    const { BUDGET_HALT_REASON } = await import("../agent/lib/budget");
    const usage = ((await import("../agent/subagents/teammate/hooks/usage")) as HookModule).default;
    // A step that spends past the run's reservation with no headroom left halts it (as in budget.test.ts).
    const ctx = {
      session: { id: SESSION, auth: { current: { principalId: "runtime", principalType: "runtime", authenticator: "test", attributes: { workspaceId: WS, room: "desk" } }, initiator: null }, turn: { id: "t", sequence: 1 } },
      agent: { name: "teammate" },
      channel: {},
    } as never;
    await usage.events["step.completed"]!({ type: "step.completed", meta: { id: "evt_spend" }, data: { usage: { inputTokens: 1000, outputTokens: 100, costUsd: 11 } } } as never, ctx);
    expect(await budget.runHalted(WS, "lease_A")).toBe(true);

    const turn = await botTurn({ script: [] });
    expect(turn.modelCalls).toBe(0);
    expect(turn.parked).toBe(true);
    expect(turn.settled).toEqual({ isError: true, output: BUDGET_HALT_REASON });
    const failed = turn.events.find((event) => event.type === "turn.failed");
    expect(failed?.data).toMatchObject({ code: "EVENT_HANDLER_FAILED", message: BUDGET_HALT_REASON });
    expect(turn.events.map((event) => event.type)).not.toContain("message.completed");
  });

  it("lets the step that overspent finish, then makes no further model call in the same turn", async () => {
    const { budget } = await boundRun();
    const { BUDGET_HALT_REASON } = await import("../agent/lib/budget");
    const ran: string[] = [];
    // The first answer costs more than the run reserved, with nothing left in the workspace.
    const turn = await botTurn({ script: [callTool("look", 11), say("Done looking.")], tools: recordingTool("look", ran) });
    expect(await budget.runHalted(WS, "lease_A")).toBe(true);
    expect(ran).toEqual(["look"]);
    expect(turn.modelCalls).toBe(1);
    expect(turn.settled).toEqual({ isError: true, output: BUDGET_HALT_REASON });
  });
});
