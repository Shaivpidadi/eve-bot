import { disableTool } from "eve/tools";

/**
 * eve's built-in task_cancel, switched off for HQ.
 *
 * Cancelling a job is `cancel_job`, which goes through `cancelJobRun` like every
 * other way of stopping a job (see `lib/cancel.ts`): the job is cancelled
 * durably, the bot is refused every further write and guarded action and makes
 * no further model call, and the `run_job` task then ends as cancelled
 * (`run-stop.ts`). Cancelling the eve
 * task underneath as well was observed (eve 0.58.1, local world) to leave HQ's
 * session deaf to every later task completion: the wake-ups were recorded but
 * never started a turn, so finished jobs stopped reaching the thread. Nothing
 * HQ needs is lost without it.
 */
export default disableTool();
