import { resumeHook } from "workflow/api";

import { releaseRun } from "./budget";
import { cancelJob, type Cancel } from "./jobs";
import { runStopToken, type RunStop } from "./run-stop";
import type { Job } from "./types";

/**
 * Stops a bot's session: its turn, the background work it owns, and the session
 * itself. Given a session id; throws when it could not.
 */
export type Interrupt = (sessionId: string) => Promise<void>;

/**
 * Wakes the `run_job` run holding the lease `leaseToken` (see `run-stop.ts`).
 * True when a run was listening and took the signal; false when none was (it
 * ended, had not started listening yet, or the runtime did not answer).
 */
export type StopRun = (leaseToken: string) => Promise<boolean>;

/**
 * What happened to the job's sessions (see `sessionsToInterrupt`):
 *
 * - `interrupted`: eve accepted the cancel and the reset of every one.
 * - `no-session`: the job names no session (none was working, or its run had
 *   not called `job_brief` yet, in which case binding is refused from now on).
 * - `failed`: eve did not confirm in time or refused, for at least one;
 *   `interruptError` says why.
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
      /** The session bound to the run that held the job (its lease's), if one had bound. */
      session: string | null;
      /** Every session the cancel stops: `session` and the job's recorded session, once each. */
      sessions: readonly string[];
      interruption: Interruption;
      interruptError?: string;
      /**
       * Whether the run that held the job took the stop signal: it has stopped
       * waiting on the bot and ends as cancelled within seconds. False when
       * no run was listening (none held the job, it ended, or it had not
       * started listening), and the run ends at its next check instead.
       */
      runStopped: boolean;
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
 * 2. The run, for every caller: `stopRun` resumes the hook the `run_job` run
 *    waits on under the cancelled lease's token, so the run stops waiting on
 *    its bot and ends as cancelled within seconds, not at its next heartbeat.
 *    The bot's own session is not stopped by this (eve gives a workflow no
 *    handle on the child it started); it stops before its next model call,
 *    when the teammate's `fence` hook finds the job cancelled.
 * 3. The session, when the caller can: `interrupt` stops the job's sessions (see
 *    `sessionsToInterrupt`), so the bot stops mid-step instead of at its next
 *    step and its pending requests (an approval card, a cost-limit card, a
 *    takeover) go with it. Channel routes
 *    pass `interruptVia(attachSession)`; tools have no handle on another
 *    session in eve 0.58, so they pass nothing.
 * 4. If signalling or interrupting fails, step 1 stands as the backstop and
 *    the answer says so.
 * 5. The run's budget reservation is released, so what it held but did not
 *    spend is free for other runs at once. Whatever the bot spends between
 *    the cancel and its session stopping still counts (the usage hook charges
 *    it to the released reservation, which holds nothing more).
 *
 * Idempotent: cancelling a cancelled job succeeds, signals its run again
 * (harmless: a run that ended has no hook left to resume) and interrupts its
 * sessions again, which is how a failed interruption is retried.
 */
export async function cancelJobRun(
  workspaceId: string,
  jobId: string,
  options: { interrupt?: Interrupt; stopRun?: StopRun } = {},
): Promise<JobCancellation> {
  const cancelled = await cancelJob(workspaceId, jobId);
  if (!cancelled.ok) return cancelled;
  // Idempotent, and a no-op for a lease that reserved nothing (a wait, a dispatch).
  if (cancelled.token !== null) await releaseRun(workspaceId, cancelled.token).catch(() => false);
  // After the durable cancel, never before: the run decides from the record.
  const stopRun = options.stopRun ?? stopRunHook;
  const runStopped = cancelled.token !== null && (await stopRun(cancelled.token).catch(() => false));
  const sessions = sessionsToInterrupt(cancelled.session, cancelled.job);
  const base = {
    ok: true as const,
    job: cancelled.job,
    wasRunning: cancelled.wasRunning,
    alreadyCancelled: cancelled.alreadyCancelled,
    session: cancelled.session,
    sessions,
    runStopped,
  };
  if (options.interrupt === undefined) return { ...base, interruption: "unavailable" };
  if (sessions.length === 0) return { ...base, interruption: "no-session" };
  const problems: string[] = [];
  for (const sessionId of sessions) {
    try {
      await options.interrupt(sessionId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      problems.push(sessions.length > 1 ? `${sessionId}: ${message}` : message);
    }
  }
  return problems.length === 0
    ? { ...base, interruption: "interrupted" }
    : { ...base, interruption: "failed", interruptError: problems.join("; ") };
}

/**
 * The sessions a cancel stops: the one bound to the run's lease, and the
 * session the job records (`job.sessionId`), deduplicated. They are the same
 * session once a run has called `job_brief`. They differ for a run that has
 * not bound yet and for a lease written before runs were fenced, where the
 * recorded session is the only one known; it may also be an earlier run's,
 * whose leftover requests (a cost-limit card, say) must not stay answerable
 * either. Stopping a session that already ended is harmless, and it is what
 * starting a room over always did.
 */
export function sessionsToInterrupt(leaseSession: string | null, job: Pick<Job, "sessionId">): string[] {
  return [...new Set([leaseSession, job.sessionId].filter((id): id is string => typeof id === "string" && id !== ""))];
}

/**
 * The `StopRun` every caller gets: resumes the run's stop hook through the
 * Workflow runtime. A hook nobody is waiting on (the run ended, or has not
 * reached its first wait) is `HookNotFoundError`, which is an answer, not a
 * failure: the job is cancelled durably either way. Bounded like an interrupt,
 * since a person may be waiting on the answer.
 */
export async function stopRunHook(leaseToken: string): Promise<boolean> {
  const stop: RunStop = { reason: "cancelled" };
  return within(resumeHook(runStopToken(leaseToken), stop)).then(
    () => true,
    () => false,
  );
}

/** The slice of eve's `attachSession(id)` handle an interruption uses. */
export interface SessionControl {
  cancel(options: { tasks: boolean }): Promise<unknown>;
  reset(options: { reason?: string }): Promise<unknown>;
}

const INTERRUPT_TIMEOUT_MS = 8_000;

/**
 * `work`, or a rejection ("timed out after …ms") once `ms` pass without it
 * settling; the timer is cleared either way. For calls into eve that may never
 * answer on 0.58 while a person waits. `work` itself is not cancelled.
 */
export function within<T>(work: Promise<T>, ms: number = INTERRUPT_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

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
  return async (sessionId) => {
    const session = attachSession(sessionId);
    const problems: string[] = [];
    await within(session.cancel({ tasks: true }), timeoutMs).catch((error: unknown) => {
      problems.push(`cancel: ${error instanceof Error ? error.message : String(error)}`);
    });
    await within(session.reset({ reason }), timeoutMs).catch((error: unknown) => {
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
      if (outcome.sessions.length === 0) return "No bot session was bound to it.";
      return outcome.runStopped
        ? "The run was stopped. The bot's session ends its current step but makes no further model call, and every action it tries is refused. Starting the thread over from the console ends the session at once."
        : "The bot's session was not stopped from here: it makes no further model call and every action it tries is refused, and its run ends at its next check, within about 8 minutes. Starting the thread over from the console ends the session at once.";
  }
}
