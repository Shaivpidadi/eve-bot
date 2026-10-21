/**
 * What `run_job` does with a harness session, one call per workflow step:
 * start it and bind it to the job's run, look at how its turn is going, and
 * stop it.
 *
 * durable-harness is loaded here only by dynamic import, so nothing reaches
 * a deployment with engines off, and the workflow bundle never carries it.
 *
 * Three things here rest on behaviour the live half of H0 has to confirm
 * (plan section 6), each marked where it is used:
 * 1. A HostTool's `io.ctx.runId` is the session id `sessions.start` returns.
 * 2. A turn's end shows on the session's live stream as `{ type: "idle" }`
 *    (or `{ type: "error" }` when it failed).
 * 3. Whether `sessions.close` stops a turn in flight. Until that passes,
 *    stopping also deletes the session's Sandbox and Drive, which stops
 *    whatever the VM was doing.
 *
 * H0 (Oct 21) passed 1 and 2; 3 failed in part (nothing more is logged, but
 * a tool already running is not aborted), so stopping keeps deleting the VM.
 * It also showed spend can be read from the log while a turn runs, which is
 * how each look charges the workspace budget as it goes (`chargeHarnessSpend`).
 */
import { bindRun, describeRunRefusal, patchJob } from "../jobs";
import { chargeUsage } from "../spend";
import { addUsage, type Usage } from "../usage";
import { DEFAULT_CODEX_MODEL } from "./codex";
import { type HarnessEngine, SPEND_STREAMS } from "./index";
import type { HarnessSessionConfig } from "./host-tools";

/** How long one look at the live stream waits for news before it reports "still working". */
const LOOK_MS = 2_000;

export type HarnessStart = { readonly ok: true; readonly sessionId: string } | { readonly ok: false; readonly error: string };

/** One model call's cost, as the engine logged it. */
export interface SpendRecord {
  readonly usd: number;
  readonly model: string | null;
}

export type HarnessLook = (
  | { readonly kind: "working"; readonly cursor: string | null }
  | { readonly kind: "ended"; readonly ok: true }
  | { readonly kind: "ended"; readonly ok: false; readonly error: string }
) & {
  /** Every model call the session's log has priced so far, in order. */
  readonly spend: readonly SpendRecord[];
  /**
   * What the model wrote since `cursor`, one entry per stretch of text (a tool
   * call or the turn's end closes one), and the stretch still being written
   * when the look ended, for the next look to finish.
   */
  readonly said: readonly string[];
  readonly partial: string;
  /** Where the live stream was read to: the same `said` is never heard twice from here. */
  readonly heard: string | null;
};

/** The slice of durable-harness's `DurableSessions` used here, so tests can stand one in. */
export interface HarnessSessions {
  start(options: { config: HarnessSessionConfig }): Promise<{ sessionId: string }>;
  send(sessionId: string, text: string, kind?: "prompt" | "steer" | "followUp"): Promise<string>;
  inspect(sessionId: string): Promise<{ status: string; failure?: { message: string }; effectOrder?: readonly { name: string; status: string; input?: unknown }[] }>;
  close(sessionId: string): Promise<void>;
  liveEntries(sessionId: string, options?: { cursor?: string; signal?: AbortSignal; resume?: boolean }): AsyncGenerator<{ value: unknown; cursor: string }>;
}

export interface HarnessDeps {
  readonly sessions: HarnessSessions;
  readonly deleteSandbox: (sessionId: string) => Promise<unknown>;
}

/**
 * durable-harness by a name the bundler cannot follow: the agent service is
 * built without it unless `BOT_ENGINES` is on at build, and then it is kept
 * as a runtime dependency (`build.externalDependencies` in `agent/agent.ts`).
 */
const harnessModule = (entry: string): Promise<unknown> => {
  const name = ["durable-harness", entry].join("/");
  return import(/* @vite-ignore */ name);
};


const loaded = new Map<HarnessEngine, Promise<HarnessDeps>>();

/** The engine's agent, made once per process from the same options its queue route uses. */
function load(engine: HarnessEngine): Promise<HarnessDeps> {
  let deps = loaded.get(engine);
  if (deps === undefined) {
    deps = (async (): Promise<HarnessDeps> => {
      const { sandbox, deleteSessionSandbox } = (await harnessModule("sandbox")) as typeof import("durable-harness/sandbox");
      let sessions: unknown;
      if (engine === "claude-code") {
        const [{ claudeCode }, { claudeCodeOptions }] = (await Promise.all([harnessModule("claude-code"), import("./claude-code")])) as [
          typeof import("durable-harness/claude-code"),
          typeof import("./claude-code"),
        ];
        sessions = claudeCode(claudeCodeOptions(sandbox)).sessions;
      } else {
        const [{ codex }, { codexOptions }] = (await Promise.all([harnessModule("codex"), import("./codex")])) as [typeof import("durable-harness/codex"), typeof import("./codex")];
        sessions = codex(codexOptions(sandbox)).sessions;
      }
      return { sessions: sessions as HarnessSessions, deleteSandbox: (sessionId: string) => deleteSessionSandbox(sessionId, { force: true }) };
    })();
    deps.catch(() => loaded.delete(engine));
    loaded.set(engine, deps);
  }
  return deps;
}

/**
 * The model a record names when it names none: Codex's spend records carry
 * only the cost, and a Codex agent runs one model (`./codex`).
 */
function defaultModelOf(engine: HarnessEngine, env: Readonly<Record<string, string | undefined>> = process.env): string | null {
  return engine === "codex" ? env.BOT_CODEX_MODEL?.trim() || DEFAULT_CODEX_MODEL : null;
}

/** The priced model calls in a session's log: the engine's spend stream, folded from completed journal effects. */
export function spendOf(engine: HarnessEngine, state: { readonly effectOrder?: readonly { name: string; status: string; input?: unknown }[] }): SpendRecord[] {
  const stream = SPEND_STREAMS[engine];
  const fallback = defaultModelOf(engine);
  const records: SpendRecord[] = [];
  for (const effect of state.effectOrder ?? []) {
    if (effect.name !== "journal" || effect.status !== "completed") continue;
    const batch = effect.input as { streams?: Record<string, { entries?: readonly { data?: unknown }[] }> } | undefined;
    for (const entry of batch?.streams?.[stream]?.entries ?? []) {
      const data = entry.data as { usd?: unknown; model?: unknown } | undefined;
      if (typeof data?.usd !== "number" || !Number.isFinite(data.usd)) continue;
      records.push({ usd: data.usd, model: typeof data.model === "string" ? data.model : fallback });
    }
  }
  return records;
}

/**
 * Starts a session for one run of a job: binds it to the run's lease before
 * the model sees anything (so its first tool call is already the job's run),
 * then sends the brief. A run that lost the job meanwhile gets nothing.
 */
export async function startHarnessRun(
  engine: HarnessEngine,
  input: { readonly workspaceId: string; readonly jobId: string; readonly token: string; readonly brief: string },
  deps?: HarnessDeps,
): Promise<HarnessStart> {
  const { sessions, deleteSandbox } = deps ?? (await load(engine));
  let sessionId: string;
  try {
    ({ sessionId } = await sessions.start({ config: { workspaceId: input.workspaceId, jobId: input.jobId } }));
  } catch (error) {
    return { ok: false, error: `Could not start the ${engine} session: ${error instanceof Error ? error.message : String(error)}` };
  }
  // H0 check 1: the tools fence on io.ctx.runId, taken to be this id.
  const bound = await bindRun(input.workspaceId, input.jobId, input.token, sessionId);
  if (!bound.ok) {
    await stopSession({ sessions, deleteSandbox }, sessionId);
    return { ok: false, error: describeRunRefusal(bound.reason, input.jobId) };
  }
  try {
    await sessions.send(sessionId, input.brief, "prompt");
  } catch (error) {
    await stopSession({ sessions, deleteSandbox }, sessionId);
    return { ok: false, error: `Could not hand the brief to the ${engine} session: ${error instanceof Error ? error.message : String(error)}` };
  }
  return { ok: true, sessionId };
}

/**
 * Whether the session's turn is still going: its run's status, then what its
 * live stream said since `cursor`, the model's text included.
 */
export async function lookAtHarnessRun(
  engine: HarnessEngine,
  sessionId: string,
  cursor: string | null,
  deps?: HarnessDeps,
  /** The text the last look caught mid-stretch, which this one goes on with. */
  carried = "",
): Promise<HarnessLook> {
  const { sessions } = deps ?? (await load(engine));
  const state = await sessions.inspect(sessionId);
  const spend = spendOf(engine, state);
  // Text the last look left unfinished is finished by the end; heard as a stretch of its own.
  const quiet = carried.trim() === "" ? { spend, said: [], partial: "", heard: cursor } : { spend, said: [carried.trim()], partial: "", heard: `${cursor ?? ""}#end` };
  if (state.status === "failed") return { kind: "ended", ok: false, error: state.failure?.message ?? "The session failed.", ...quiet };
  if (state.status === "cancelled") return { kind: "ended", ok: false, error: "The session was cancelled.", ...quiet };
  if (state.status === "completed") return { kind: "ended", ok: true, ...quiet };

  // H0 check 2: a turn's end is an `idle` event on the live stream.
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), LOOK_MS);
  let last = cursor;
  const said: string[] = [];
  let text = carried;
  const close = (): void => {
    if (text.trim() !== "") said.push(text.trim());
    text = "";
  };
  try {
    for await (const entry of sessions.liveEntries(sessionId, { ...(cursor === null ? {} : { cursor }), signal: stop.signal, resume: false })) {
      last = entry.cursor;
      const value = typeof entry.value === "object" && entry.value !== null ? (entry.value as { type?: unknown; delta?: unknown; message?: unknown }) : {};
      if (value.type === "text" && typeof value.delta === "string") text += value.delta;
      else if (value.type === "tool_start") close();
      else if (value.type === "error") {
        close();
        return { kind: "ended", ok: false, error: typeof value.message === "string" ? value.message : "The turn failed.", spend, said, partial: "", heard: last };
      } else if (value.type === "idle") {
        close();
        return { kind: "ended", ok: true, spend, said, partial: "", heard: last };
      }
    }
  } catch {
    // The look timed out or the stream closed: nothing ended that we saw.
  } finally {
    clearTimeout(timer);
  }
  return { kind: "working", cursor: last, spend, said, partial: text, heard: last };
}

/** The most one stretch of a Bot's words keeps in its thread. */
const SAID_LIMIT = 4_000;

/**
 * Puts what the model wrote into the Bot's thread, as its own words while the
 * job runs. Once per stretch of the stream: the job notes how far its thread
 * has heard the session, so a look that runs again adds nothing twice (a look
 * cut short between the two writes loses its words rather than repeating them).
 */
export async function tellThread(input: {
  readonly workspaceId: string;
  readonly jobId: string;
  readonly botId: string;
  readonly sessionId: string;
  readonly heard: string | null;
  readonly said: readonly string[];
}): Promise<void> {
  if (input.said.length === 0 || input.heard === null) return;
  let fresh = false;
  await patchJob(input.workspaceId, input.jobId, (current) => {
    fresh = current.harnessHeard?.[input.sessionId] !== input.heard;
    return fresh ? { ...current, harnessHeard: { ...current.harnessHeard, [input.sessionId]: input.heard! } } : current;
  }).catch(() => null);
  if (!fresh) return;
  const { record } = await import("../activity");
  for (const words of input.said) {
    const text = words.length > SAID_LIMIT ? `${words.slice(0, SAID_LIMIT - 1)}\u2026` : words;
    await record({ workspaceId: input.workspaceId, kind: "job.progress", botId: input.botId, jobId: input.jobId, text, data: { said: true } }).catch(() => undefined);
  }
}

/**
 * Charges what a session spent since the last look: each priced model call
 * once (keyed by the session and its place in the log, so a look that runs
 * again counts nothing twice), to the usage ledger, the job's own usage and
 * the run's reservation in the workspace budget. Says whether the budget now
 * halts the run, so the heartbeat can stop it at once rather than at the end.
 */
export async function chargeHarnessSpend(input: {
  readonly workspaceId: string;
  readonly jobId: string;
  readonly botId: string;
  readonly token: string;
  readonly sessionId: string;
  readonly spend: readonly SpendRecord[];
  readonly charged: number;
}): Promise<{ readonly charged: number; readonly halted: boolean }> {
  const usageOf = (record: SpendRecord): Usage => ({
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: record.usd,
    steps: 1,
    models: { [record.model ?? "unknown"]: 1 },
  });
  // The job notes how far its usage has counted this session, in the same write, so a retried look adds nothing.
  let from = input.charged;
  await patchJob(input.workspaceId, input.jobId, (current) => {
    from = Math.max(input.charged, current.harnessCharged?.[input.sessionId] ?? 0);
    const fresh = input.spend.slice(from);
    if (fresh.length === 0) return current;
    const usage = fresh.map(usageOf).reduce<Usage | undefined>((total, next) => addUsage(total, next), current.usage);
    return { ...current, ...(usage === undefined ? {} : { usage }), harnessCharged: { ...current.harnessCharged, [input.sessionId]: input.spend.length } };
  }).catch(() => null);
  let halted = false;
  // The budget is idempotent by id on its own: each call is charged once, whoever charges it.
  for (let index = input.charged; index < input.spend.length; index += 1) {
    const outcome = await chargeUsage(input.workspaceId, { botId: input.botId }, usageOf(input.spend[index]!), {
      runToken: input.token,
      costReported: true,
      id: `${input.sessionId}:spend:${index}`,
    }).catch(() => ({ counted: false, halted: false }));
    halted ||= outcome.halted;
  }
  return { charged: Math.max(input.charged, input.spend.length, from), halted };
}

async function stopSession(deps: HarnessDeps, sessionId: string): Promise<void> {
  await deps.sessions.close(sessionId).catch(() => undefined);
  // H0 check 3: until close is shown to stop a turn in flight, the VM goes too.
  await deps.deleteSandbox(sessionId).catch(() => undefined);
}

/** Tells a running session something as a follow-up message, such as what a person decided about its email. */
export async function tellHarnessSession(engine: HarnessEngine, sessionId: string, text: string, deps?: HarnessDeps): Promise<void> {
  await (deps ?? (await load(engine))).sessions.send(sessionId, text, "followUp");
}

/** Stops a session for good: closes it and deletes its Sandbox and Drive. Best effort and idempotent. */
export async function stopHarnessRun(engine: HarnessEngine, sessionId: string, deps?: HarnessDeps): Promise<void> {
  await stopSession(deps ?? (await load(engine)), sessionId);
}
