import { releaseRun } from "./budget";
import { cancelJob, type Cancel } from "./jobs";
import type { Job } from "./types";

/**
 * Stops a bot's session: its turn, the background work it owns, and the session
 * itself. Given a session id; throws when it could not.
 */
export type Interrupt = (sessionId: string) => Promise<void>;

/**
 * What happened to the run's session:
 *
 * - `interrupted`: eve accepted the cancel and the reset.
 * - `no-session`: no run had bound a session (none was working, or it had not
 *   called `job_brief` yet, in which case binding is refused from now on).
 * - `failed`: eve did not confirm in time or refused; `interruptError` says why.
 * - `unavailable`: the caller has no way to reach another session (a tool; see
 *   `cancel_job`).
 *
 * Whatever the answer, the job is cancelled durably and the run is fenced.
 */
export type Interruption = "interrupted" | "no-session" | "failed" | "unavailable";

export type JobCancellation =
  | {
      ok: true;
      job: Job;
      wasRunning: boolean;
      alreadyCancelled: boolean;
      session: string | null;
      interruption: Interruption;
      interruptError?: string;
    }
  | Extract<Cancel, { ok: false }>;

/**
 * Cancels a job, one way for every caller: the `cancel_job` tool, the console's
 * Stop (`DELETE /bot/v1/jobs/:jobId`), removing a bot, and starting a room over.
 *
 * 1. Durably: `cancelJob` marks the job cancelled and drops its lease in one
 *    compare-and-set. From then on the running bot's job writes and guarded
 *    side effects are refused, its parent's heartbeat fails, and nothing can
 *    close the job as done, blocked or sent back.
 * 2. Promptly, when the caller can: `interrupt` stops the session bound to the
 *    run, so the bot stops mid-step instead of at its next refusal and its
 *    pending requests (an approval card, a takeover) go with it. Channel routes
 *    pass `interruptVia(attachSession)`; tools have no handle on another
 *    session in eve 0.58, so they pass nothing.
 * 3. If interrupting fails, step 1 stands as the backstop and the answer says so.
 * 4. The run's budget reservation is released, so what it held but did not
 *    spend is free for other runs at once. Whatever the bot spends between
 *    the cancel and its session stopping still counts (the usage hook charges
 *    it to the released reservation, which holds nothing more).
 *
 * Idempotent: cancelling a cancelled job succeeds and interrupts its run again,
 * which is how a failed interruption is retried.
 */
export async function cancelJobRun(
  workspaceId: string,
  jobId: string,
  options: { interrupt?: Interrupt } = {},
): Promise<JobCancellation> {
  const cancelled = await cancelJob(workspaceId, jobId);
  if (!cancelled.ok) return cancelled;
  // Idempotent, and a no-op for a lease that reserved nothing (a wait, a dispatch).
  if (cancelled.token !== null) await releaseRun(workspaceId, cancelled.token).catch(() => false);
  const base = {
    ok: true as const,
    job: cancelled.job,
    wasRunning: cancelled.wasRunning,
    alreadyCancelled: cancelled.alreadyCancelled,
    session: cancelled.session,
  };
  if (options.interrupt === undefined) return { ...base, interruption: "unavailable" };
  if (cancelled.session === null) return { ...base, interruption: "no-session" };
  try {
    await options.interrupt(cancelled.session);
    return { ...base, interruption: "interrupted" };
  } catch (error) {
    return {
      ...base,
      interruption: "failed",
      interruptError: error instanceof Error ? error.message : String(error),
    };
  }
}

/** The slice of eve's `attachSession(id)` handle an interruption uses. */
export interface SessionControl {
  cancel(options: { tasks: boolean }): Promise<unknown>;
  reset(options: { reason?: string }): Promise<unknown>;
}

const INTERRUPT_TIMEOUT_MS = 8_000;

/**
 * An `Interrupt` from a channel route's `attachSession`, the way starting a room
 * over always stopped its jobs' sessions: cancel the turn and every task the
 * session owns, then retire the session, so nothing it left pending (an
 * approval, a takeover) can be answered into action later. Each call is bounded
 * because on eve 0.58 a session can fail to answer and a person is waiting.
 * Both are attempted; it throws if either failed.
 */
export function interruptVia(
  attachSession: (sessionId: string) => SessionControl,
  reason: string,
  timeoutMs = INTERRUPT_TIMEOUT_MS,
): Interrupt {
  const within = <T>(work: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    return Promise.race([work, late]).finally(() => clearTimeout(timer));
  };
  return async (sessionId) => {
    const session = attachSession(sessionId);
    const problems: string[] = [];
    await within(session.cancel({ tasks: true })).catch((error: unknown) => {
      problems.push(`cancel: ${error instanceof Error ? error.message : String(error)}`);
    });
    await within(session.reset({ reason })).catch((error: unknown) => {
      problems.push(`reset: ${error instanceof Error ? error.message : String(error)}`);
    });
    if (problems.length > 0) throw new Error(problems.join("; "));
  };
}

/** One line on what became of the run, for a person or a model. */
export function describeInterruption(outcome: Extract<JobCancellation, { ok: true }>): string {
  switch (outcome.interruption) {
    case "interrupted":
      return "The bot's session was stopped.";
    case "no-session":
      return outcome.wasRunning
        ? "The bot had not started its job yet; it cannot start it now."
        : "No bot was working on it.";
    case "failed":
      return `Stopping the bot's session failed (${outcome.interruptError ?? "unknown error"}). The job stays cancelled and every action the bot tries is refused; cancel again to retry.`;
    case "unavailable":
      return outcome.session === null
        ? "No bot session was bound to it."
        : "The bot's session was not stopped from here: every action it tries is now refused and its run ends at its next check, within about 8 minutes. Starting the thread over from the console ends the session at once.";
  }
}
