/**
 * How a `run_job` run waits on its bot, and how a cancelled bot stops.
 *
 * A cancel reaches the bot, not the run: the teammate's `fence` hook fails
 * the bot's turn before its next model call once its job is cancelled, which
 * settles the run's wait, and the run then finds the job cancelled and stops
 * without recording anything. The cancel also kills the run's shell commands
 * (`stopRunCommands`), so a long command ends at once; a bot parked on a card
 * is noticed at the run's next look at its job, within a minute.
 *
 * A Workflow hook resumed by the cancel was tried as a faster signal and
 * removed: creating it between the run's steps made the workflow's replay
 * diverge (`CorruptedEventLogError`, a hook in the event log where replay
 * created a step), which stops the run outright.
 *
 * Workflow-safe on purpose: `run_job`'s body imports this module, so it holds
 * no store, budget or runtime import.
 */

/** Why a cancelled job's Bot session fails its turn (the teammate's `fence` hook). */
export const CANCELLED_STOP_REASON = "The job was cancelled; this session makes no further model calls for it.";

/** What woke a run waiting on its bot: the bot settled, or its next look at the job is due. */
export type WorkWake<T> = { kind: "settled"; settled: T } | { kind: "beat" };

/** The first of the bot settling and the next look. A settled bot wins a tie. */
export function nextWake<T>(working: Promise<T>, beat: Promise<unknown>): Promise<WorkWake<T>> {
  return Promise.race([
    working.then((settled): WorkWake<T> => ({ kind: "settled", settled })),
    beat.then((): WorkWake<T> => ({ kind: "beat" })),
  ]);
}
