import { defineHook } from "eve/hooks";

import { sessionBinding } from "../../../lib/computer/screens";
import { listOpenJobs, patchJob } from "../../../lib/jobs";
import { operator } from "../../../lib/session";
import { addUsage, recordUsage, usageOfStep } from "../../../lib/usage";
import { sessionState } from "../lib/session-state";

/**
 * What a job costs, added to the job and to its Bot's ledger step by step.
 *
 * The job is found through the screen binding `job_brief` made, or, before
 * that first call, through the open job whose session this is. A step that
 * belongs to no job (there should be none) is not counted anywhere.
 */
const models = sessionState<string>();
const jobs = sessionState<{ jobId: string; botId: string }>();

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
      const modelId = (event.data as { modelId?: unknown }).modelId;
      if (typeof modelId === "string") models.set(ctx.session.id, modelId);
    },
    async "step.completed"(event, ctx) {
      try {
        const { workspaceId } = operator(ctx);
        const job = await jobOf(workspaceId, ctx.session.id);
        if (job === null) return;
        const usage = usageOfStep(event.data, models.get(ctx.session.id) ?? null);
        await patchJob(workspaceId, job.jobId, (current) => ({ ...current, usage: addUsage(current.usage, usage) }));
        await recordUsage(workspaceId, { botId: job.botId }, usage);
      } catch {
        // The ledger is a convenience; the job is not.
      }
    },
  },
});
