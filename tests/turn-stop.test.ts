import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { z } from "zod";

/**
 * A stopped Bot (its job cancelled, or its run halted by the budget) makes no
 * further model call, compaction included. The check is the teammate's model
 * resolver, which eve consults on every step before it compacts or calls the
 * model (lib/stops.ts via agent.ts); a throw there fails the step as a model
 * selection. (Since eve 0.68 a throwing hook no longer stops a turn, so the
 * resolver is the only check inside the session; run_job also cancels the
 * Bot's turn when it sees the job stopped.)
 *
 * This holds eve to that with eve's own turn loop rather than a model of it:
 * the harness (`createToolLoopHarness`), the hook dispatcher and the context
 * container are eve's, loaded from its dist; the model is the AI SDK's mock, so
 * nothing is paid for. If an eve upgrade moves these internals, this file fails
 * to load, which is the point: the guarantee must be re-checked.
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
  /** A history long enough to compact, with a threshold every history crosses. */
  compact?: boolean;
  /**
   * Whether eve consults the teammate's model resolver for each step, as it does
   * in a deployment (default). Without it only the hooks stand between a stopped
   * run and the model, which is how their backstop is tested.
   */
  resolver?: boolean;
}): Promise<{
  modelCalls: number;
  compactions: number;
  events: Event[];
  settled: { output: unknown; isError?: boolean } | undefined;
  parked: boolean;
  /** How a child's turn ended without parking: what its parent receives. */
  ended: { done: boolean; output: unknown; isError?: boolean } | null;
}> {
  const { createToolLoopHarness } = await eve("harness/tool-loop.js");
  const { dispatchStreamEventHooks } = await eve("context/hook-lifecycle.js");
  const { ContextContainer, contextStorage } = await eve("context/container.js");
  const { SessionKey, ParentSessionKey } = await eve("context/keys.js");
  const { BundleKey } = await eve("runtime/sessions/runtime-context-keys.js");

  const hooks = [
    ((await import("../agent/subagents/teammate/hooks/usage")) as HookModule).default,
  ];
  const byType = new Map<string, Array<{ handler: (event: never, ctx: never) => unknown }>>();
  for (const hook of hooks) {
    for (const [type, handler] of Object.entries(hook.events)) byType.set(type, [...(byType.get(type) ?? []), { handler }]);
  }
  const registry = { streamEventsByType: byType, streamEventsWildcard: [] };

  let modelCalls = 0;
  let compactions = 0;
  const model = new MockLanguageModelV4({
    // eve's compaction summarises with a plain generate call.
    doGenerate: async () => {
      compactions += 1;
      return {
        content: [{ type: "text", text: "Summary of the work so far." }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: finish("stop").usage,
        warnings: [],
      };
    },
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
  ctx.set(BundleKey, { turnAgent: { id: "teammate" }, nodeId: "teammate", subagentRegistry: { dynamicResolvers: [] }, resolvedAgent: { skills: [] } });
  // A teammate always runs as HQ's child, which is what makes a refused step an error result for its parent.
  ctx.set(ParentSessionKey, { sessionId: "sess_hq" });

  // The teammate's real model resolver, which eve consults for each step before it compacts.
  const teammate = ((await import("../agent/subagents/teammate/agent")) as { default: { model: { events: Record<string, (event: unknown, ctx: unknown) => unknown> } } }).default;
  const resolveStep = teammate.model.events["step.started"]!;

  const events: Event[] = [];
  const step = createToolLoopHarness({
    mode: "conversation",
    tools: options.tools ?? new Map(),
    resolveModel: async () => model,
    ...(options.resolver === false
      ? {}
      : {
          dispatchDynamicModelEvent: async ({ event, messages }: { event: unknown; messages: unknown[] }) => {
            await resolveStep(event, { session: { id: SESSION, auth }, messages, model: null, channel: {} });
          },
        }),
    handleEvent: async (event: Event) => {
      events.push(event);
      await dispatchStreamEventHooks({ ctx, registry, event: { ...event, meta: { id: `evt_${events.length}`, at: new Date().toISOString() } } });
    },
  });
  const session = {
    agent: { system: "You are a Bot.", tools: [], modelReference: { id: "mock/model" } },
    // Far above anything here unless the test compacts: compaction makes a model call of its own.
    compaction: options.compact === true ? { recentWindowSize: 2, threshold: 1 } : { recentWindowSize: 10, threshold: 100_000_000 },
    continuationToken: "cont_1",
    history:
      options.compact === true
        ? Array.from({ length: 6 }, (_, i) =>
            i % 2 === 0
              ? { role: "user", kind: "user", content: `Earlier work, part ${i + 1}. `.repeat(50) }
              : { role: "assistant", content: `Done with part ${i}. `.repeat(50) },
          )
        : [],
    sessionId: SESSION,
    state: {},
  };

  const result = await contextStorage.run(ctx, async () => {
    let current = await step(session, { message: "Do the job." });
    // A function is eve's "call this step now": the tool loop continuing.
    while (typeof current.next === "function") current = await current.next(current.session);
    return current;
  });
  const ended = typeof result.next === "object" && result.next !== null ? (result.next as { done: boolean; output: unknown; isError?: boolean }) : null;
  return { modelCalls, compactions, events, settled: result.settledTurn, parked: result.next === null, ended };
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

describe("a stopped teammate turn", () => {
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
    // A child's turn that answered ends with the session waiting for its next message (eve 0.79).
    expect(turn.events.map((event) => event.type)).toContain("session.waiting");
  });

  it("with the model resolver in front: makes no model call once the budget halted the run", async () => {
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
    expect(turn.ended).toEqual({ done: true, isError: true, output: BUDGET_HALT_REASON });
    expect(turn.events.map((event) => event.type)).not.toContain("message.completed");
  });

  it("with the model resolver in front: a cancelled run's step fails before any model call, as an error its parent receives", async () => {
    const { job } = await boundRun();
    const { cancelJobRun } = await import("../agent/lib/cancel");
    const { CANCELLED_STOP_REASON } = await import("../agent/lib/run-stop");
    expect((await cancelJobRun(WS, job.id)).ok).toBe(true);
    const turn = await botTurn({ script: [] });
    expect(turn.modelCalls).toBe(0);
    expect(turn.ended).toEqual({ done: true, isError: true, output: CANCELLED_STOP_REASON });
    expect(turn.events.find((event) => event.type === "step.failed")?.data).toMatchObject({ code: "MODEL_SELECTION_FAILED" });
  });

  it("with the model resolver in front: the step in flight finishes, the next makes no model call", async () => {
    const { jobs, job } = await boundRun();
    const { cancelJobRun } = await import("../agent/lib/cancel");
    const { CANCELLED_STOP_REASON } = await import("../agent/lib/run-stop");
    const ran: string[] = [];
    const tools = recordingTool("look", ran, async () => {
      expect((await cancelJobRun(WS, job.id)).ok).toBe(true);
    });
    const turn = await botTurn({ script: [callTool("look"), say("Done looking.")], tools });
    expect(ran).toEqual(["look"]);
    expect(turn.modelCalls).toBe(1);
    expect(turn.ended).toEqual({ done: true, isError: true, output: CANCELLED_STOP_REASON });
    expect((await jobs.getJob(WS, job.id))?.status).toBe("cancelled");
  });

  it("with the model resolver in front: a budget halt stops the next step the same way", async () => {
    await boundRun();
    const { BUDGET_HALT_REASON } = await import("../agent/lib/budget");
    const ran: string[] = [];
    const turn = await botTurn({ script: [callTool("look", 11), say("Done looking.")], tools: recordingTool("look", ran) });
    expect(ran).toEqual(["look"]);
    expect(turn.modelCalls).toBe(1);
    expect(turn.ended).toEqual({ done: true, isError: true, output: BUDGET_HALT_REASON });
  });

  it("makes no compaction call either once the job is cancelled: the model resolver refuses first", async () => {
    const { job } = await boundRun();
    const { cancelJobRun } = await import("../agent/lib/cancel");
    expect((await cancelJobRun(WS, job.id)).ok).toBe(true);
    const turn = await botTurn({ script: [], compact: true });
    expect(turn.compactions).toBe(0);
    expect(turn.modelCalls).toBe(0);
    expect(turn.events.map((event) => event.type)).not.toContain("compaction.requested");
  });

  it("makes no compaction call once the budget halted the run", async () => {
    await boundRun();
    const { markHalted } = await import("../agent/subagents/teammate/lib/stops");
    markHalted(SESSION);
    const turn = await botTurn({ script: [], compact: true });
    expect(turn.compactions).toBe(0);
    expect(turn.modelCalls).toBe(0);
  });
});
