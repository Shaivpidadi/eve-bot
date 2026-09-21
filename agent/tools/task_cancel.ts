import { disableTool } from "eve/tools";

/**
 * eve's built-in task_cancel, switched off for HQ.
 *
 * Cancelling a job is `cancel_job`: the dispatcher notices within its next
 * heartbeat and the run ends as superseded. Cancelling the eve task underneath
 * as well was observed (eve 0.58.1, local world) to leave HQ's session deaf to
 * every later task completion: the wake-ups were recorded but never started a
 * turn, so finished jobs stopped reaching the thread. Nothing HQ needs is lost
 * without it.
 */
export default disableTool();
