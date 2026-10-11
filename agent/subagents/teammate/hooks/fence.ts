import { defineHook } from "eve/hooks";

import { sessionBinding } from "../../../lib/computer/screens";
import { getJob } from "../../../lib/jobs";
import { CANCELLED_STOP_REASON } from "../../../lib/run-stop";
import { operator } from "../../../lib/session";
import { sessionState } from "../lib/session-state";

/**
 * Stops a Bot whose job was cancelled, before its next model call.
 *
 * A cancel from a thread cannot reach the Bot's session: tools have no
 * session handle in eve 0.58, and the `run_job` run that started the Bot has
 * no handle on its child either (`ctx.agent` returns only a promise). Its job
 * writes and guarded actions are refused from the cancel on; this ends the
 * rest, and failing the Bot's turn is also what ends the run's wait on it
 * (`run-stop.ts`). eve fails the turn when a `step.started` hook throws, before the
 * model request is made (harness/tool-loop.js: `emitStepStarted` runs inside
 * the try whose catch is `failBoundaryEvent`; a child session runs in
 * conversation mode, so the turn ends `turn.failed` + `session.waiting` and
 * its parent receives an error result). tests/turn-stop.test.ts runs a real
 * eve turn to hold eve to that.
 *
 * The step in flight when the cancel lands still finishes, with its tool
 * calls refused, and a context compaction eve runs just before `step.started`
 * is not stopped. A session that never called `job_brief` is bound to no job
 * and is not fenced here; `job_brief` refuses it once the job is cancelled.
 * A read that fails lets the step through: the refusals still hold.
 */
const jobs = sessionState<string>();
const cancelled = sessionState<true>();

export default defineHook({
  events: {
    async "step.started"(_event, ctx) {
      // Outside any try: a throw here is what stops the model call.
      if (cancelled.get(ctx.session.id) === true) throw new Error(CANCELLED_STOP_REASON);
      if (!(await jobIsCancelled(ctx.session.id, () => operator(ctx).workspaceId))) return;
      cancelled.set(ctx.session.id, true);
      throw new Error(CANCELLED_STOP_REASON);
    },
  },
});

async function jobIsCancelled(sessionId: string, workspace: () => string): Promise<boolean> {
  try {
    const workspaceId = workspace();
    let jobId = jobs.get(sessionId);
    if (jobId === undefined) {
      const binding = await sessionBinding(workspaceId, sessionId);
      if (binding === null) return false;
      jobId = binding.jobId;
      jobs.set(sessionId, jobId);
    }
    return (await getJob(workspaceId, jobId))?.status === "cancelled";
  } catch {
    return false;
  }
}
