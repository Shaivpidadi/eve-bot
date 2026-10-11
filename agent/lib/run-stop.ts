/**
 * The stop signal between a cancel and the `run_job` run it cancels.
 *
 * A run waits on a Workflow hook whose token is derived from the lease it
 * holds (`runStopToken`); `cancelJobRun` resumes that hook right after the
 * durable cancel, so the run stops waiting at once instead of at its next
 * heartbeat. Lease tokens are unique per claim, so a token never names two
 * runs, and resuming the hook of a run that already ended finds nothing.
 *
 * Workflow-safe on purpose: `run_job`'s body imports this module, so it holds
 * no store, budget or runtime import (see the note on `closeBudget`). The
 * resuming half lives in `cancel.ts`.
 */

/** The hook token a run listens on while it holds the lease `leaseToken`. */
export function runStopToken(leaseToken: string): string {
  return `bot-run-stop:${leaseToken}`;
}

/** What a stop carries. The run decides from the job's record, not from this. */
export interface RunStop {
  readonly reason: "cancelled";
}

/** Why a cancelled job's Bot session fails its turn (the teammate's `fence` hook). */
export const CANCELLED_STOP_REASON = "The job was cancelled; this session makes no further model calls for it.";

/** What woke a run waiting on its bot: the bot settled, a stop arrived, or the heartbeat is due. */
export type WorkWake<T> = { kind: "settled"; settled: T } | { kind: "stop" } | { kind: "beat" };

/**
 * The first of the bot settling, a stop, and the heartbeat. A settled bot wins
 * a tie with a stop: whatever it left is judged by the job's record either way.
 */
export function nextWake<T>(working: Promise<T>, stop: Promise<unknown>, beat: Promise<unknown>): Promise<WorkWake<T>> {
  return Promise.race([
    working.then((settled): WorkWake<T> => ({ kind: "settled", settled })),
    stop.then((): WorkWake<T> => ({ kind: "stop" })),
    beat.then((): WorkWake<T> => ({ kind: "beat" })),
  ]);
}

/** Waits for `wait` or a stop, whichever comes first: true when the stop did. */
export function wokeByStop(wait: Promise<unknown>, stop: Promise<unknown>): Promise<boolean> {
  return Promise.race([wait.then(() => false), stop.then(() => true)]);
}

/**
 * The next stop on `hook` (one read of it). A read that fails, as a token
 * conflict would, never fires rather than failing the run: the heartbeat and
 * the job's record still stop it.
 */
export function nextStop(hook: PromiseLike<unknown>): Promise<undefined> {
  return new Promise<undefined>((resolve) => {
    hook.then(
      () => resolve(undefined),
      () => undefined,
    );
  });
}
