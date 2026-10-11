import { defineHook } from "eve/hooks";

import { sessionBinding } from "../../../lib/computer/screens";
import { BUDGET_HALT_REASON } from "../../../lib/budget";
import { listOpenJobs, patchJob, runCheckOf } from "../../../lib/jobs";
import { operator } from "../../../lib/session";
import { chargeUsage } from "../../../lib/spend";
import type { Job } from "../../../lib/types";
import { addUsage, stepCostReported, usageOfStep } from "../../../lib/usage";
import { sessionState } from "../lib/session-state";

/**
 * What a job costs, added to the job and to its Bot's ledger step by step.
 *
 * The job is found through the screen binding `job_brief` made, or, before
 * that first call, through the open job whose session this is. A step that
 * belongs to no job (there should be none) is not counted anywhere.
 *
 * Each step's cost also draws on the workspace budget, against the
 * reservation of the run this session is (see `budget.ts`). When the budget
 * says the run has spent past its reservation with nothing left in the
 * workspace, the session is marked halted and its next `step.started` throws:
 * eve fails the turn before that model call is made, the run's parent sees the
 * child fail, finds the run halted, and blocks the job with the budget reason.
 * Hooks observe after the fact, so the step that crossed the line is spent:
 * the overrun is bounded by one step, plus one per other instance running the
 * same session, which learns of the halt at its own next completed step.
 * tests/turn-stop.test.ts runs eve's own turn loop to check that the throw
 * stops the model call. A context compaction, which eve runs just before
 * `step.started` when the history is long, is a model call this does not stop.
 */
const models = sessionState<string>();
const jobs = sessionState<{ jobId: string; botId: string }>();
const halted = sessionState<true>();

/**
 * The run whose reservation a step draws on: the lease this session holds, or,
 * before the session has bound the lease with `job_brief`, the run lease the
 * job carries now, which can only be this run's. A session that no longer
 * holds the job charges the workspace, not another run.
 */
function runTokenOf(job: Job | null, sessionId: string): string | null {
  const check = runCheckOf(job, sessionId);
  if (check.ok) return check.job.lease?.token ?? null;
  return check.reason === "unbound" ? (job?.lease?.token ?? null) : null;
}

async function jobOf(workspaceId: string, sessionId: string): Promise<{ jobId: string; botId: string } | null> {
  const cached = jobs.get(sessionId);
  if (cached !== undefined) return cached;
  const binding = await sessionBinding(workspaceId, sessionId);
  const found =
    binding !== null
      ? { jobId: binding.jobId, botId: binding.botId }
      : (() => {
          return null;
        })();
  if (found !== null) {
    jobs.set(sessionId, found);
    return found;
  }
  const open = (await listOpenJobs(workspaceId)).find((job) => job.sessionId === sessionId);
  if (open === undefined) return null;
  const answer = { jobId: open.id, botId: open.botId };
  jobs.set(sessionId, answer);
  return answer;
}

export default defineHook({
  events: {
    "step.started"(event, ctx) {
      // Outside any try: a throw here is what stops the model call.
      if (halted.get(ctx.session.id) === true) throw new Error(BUDGET_HALT_REASON);
      const modelId = (event.data as { modelId?: unknown }).modelId;
      if (typeof modelId === "string") models.set(ctx.session.id, modelId);
    },
    async "step.completed"(event, ctx) {
      try {
        const { workspaceId } = operator(ctx);
        const job = await jobOf(workspaceId, ctx.session.id);
        if (job === null) return;
        const usage = usageOfStep(event.data, models.get(ctx.session.id) ?? null);
        const updated = await patchJob(workspaceId, job.jobId, (current) => ({ ...current, usage: addUsage(current.usage, usage) }));
        const spend = await chargeUsage(workspaceId, { botId: job.botId }, usage, {
          runToken: runTokenOf(updated, ctx.session.id),
          costReported: stepCostReported(event.data),
          id: `${ctx.session.id}:${event.meta.id}`,
        });
        if (spend.halted) halted.set(ctx.session.id, true);
      } catch {
        // The ledger is a convenience; the job is not.
      }
    },
  },
});
