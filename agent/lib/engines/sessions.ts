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
 */
import { getBot } from "../bots";
import { bindRun, describeRunRefusal, listJobs } from "../jobs";
import { engineOf, type HarnessEngine } from "./index";
import type { HarnessSessionConfig } from "./host-tools";

/** How long one look at the live stream waits for news before it reports "still working". */
const LOOK_MS = 2_000;

export type HarnessStart = { readonly ok: true; readonly sessionId: string } | { readonly ok: false; readonly error: string };

export type HarnessLook =
  | { readonly kind: "working"; readonly cursor: string | null }
  | { readonly kind: "ended"; readonly ok: true }
  | { readonly kind: "ended"; readonly ok: false; readonly error: string };

/** The slice of durable-harness's `DurableSessions` used here, so tests can stand one in. */
export interface HarnessSessions {
  start(options: { config: HarnessSessionConfig }): Promise<{ sessionId: string }>;
  send(sessionId: string, text: string, kind?: "prompt" | "steer" | "followUp"): Promise<string>;
  inspect(sessionId: string): Promise<{ status: string; failure?: { message: string } }>;
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

let loaded: Promise<HarnessDeps> | null = null;

async function load(engine: HarnessEngine): Promise<HarnessDeps> {
  switch (engine) {
    case "claude-code": {
      loaded ??= (async () => {
        const [{ claudeCode }, { sandbox, deleteSessionSandbox }, { claudeCodeOptions }] = (await Promise.all([
          harnessModule("claude-code"),
          harnessModule("sandbox"),
          import("./claude-code"),
        ])) as [typeof import("durable-harness/claude-code"), typeof import("durable-harness/sandbox"), typeof import("./claude-code")];
        const agent = claudeCode(claudeCodeOptions(sandbox));
        return {
          sessions: agent.sessions as unknown as HarnessSessions,
          deleteSandbox: (sessionId: string) => deleteSessionSandbox(sessionId, { force: true }),
        };
      })();
      return loaded;
    }
  }
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

/** Whether the session's turn is still going: its run's status, then what its live stream said since `cursor`. */
export async function lookAtHarnessRun(engine: HarnessEngine, sessionId: string, cursor: string | null, deps?: HarnessDeps): Promise<HarnessLook> {
  const { sessions } = deps ?? (await load(engine));
  const state = await sessions.inspect(sessionId);
  if (state.status === "failed") return { kind: "ended", ok: false, error: state.failure?.message ?? "The session failed." };
  if (state.status === "cancelled") return { kind: "ended", ok: false, error: "The session was cancelled." };
  if (state.status === "completed") return { kind: "ended", ok: true };

  // H0 check 2: a turn's end is an `idle` event on the live stream.
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), LOOK_MS);
  let last = cursor;
  try {
    for await (const entry of sessions.liveEntries(sessionId, { ...(cursor === null ? {} : { cursor }), signal: stop.signal, resume: false })) {
      last = entry.cursor;
      const type = typeof entry.value === "object" && entry.value !== null ? (entry.value as { type?: unknown }).type : undefined;
      if (type === "error") {
        const message = (entry.value as { message?: unknown }).message;
        return { kind: "ended", ok: false, error: typeof message === "string" ? message : "The turn failed." };
      }
      if (type === "idle") return { kind: "ended", ok: true };
    }
  } catch {
    // The look timed out or the stream closed: nothing ended that we saw.
  } finally {
    clearTimeout(timer);
  }
  return { kind: "working", cursor: last };
}

async function stopSession(deps: HarnessDeps, sessionId: string): Promise<void> {
  await deps.sessions.close(sessionId).catch(() => undefined);
  // H0 check 3: until close is shown to stop a turn in flight, the VM goes too.
  await deps.deleteSandbox(sessionId).catch(() => undefined);
}

/** Stops a session for good: closes it and deletes its Sandbox and Drive. Best effort and idempotent. */
export async function stopHarnessRun(engine: HarnessEngine, sessionId: string, deps?: HarnessDeps): Promise<void> {
  await stopSession(deps ?? (await load(engine)), sessionId);
}

/**
 * Whether another job of a Bot on a harness engine is running in the
 * workspace. Until a harness run's spend can be read while it works (H0),
 * `run_job` runs one at a time, so the most a workspace can overshoot is one
 * job's limit (plan section 4.5).
 */
export async function harnessRunsElsewhere(workspaceId: string, jobId: string): Promise<boolean> {
  const running = await listJobs(workspaceId, { status: ["running"] });
  for (const job of running) {
    if (job.id === jobId) continue;
    if (engineOf(await getBot(workspaceId, job.botId)) !== "eve") return true;
  }
  return false;
}
