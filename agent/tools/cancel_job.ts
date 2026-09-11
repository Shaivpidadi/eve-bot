import { defineTool } from "eve/tools";
import { z } from "zod";

import { cancelJob, getJob } from "../lib/jobs";
import { operator } from "../lib/session";

export default defineTool({
  description:
    "Stop a job and, if it repeats, stop the repetition. Work already delivered is not undone.",
  inputSchema: z.object({ jobId: z.string() }),
  label: { start: ({ jobId }) => `Cancel ${jobId}` },
  async execute({ jobId }, ctx) {
    const who = operator(ctx);
    const existing = await getJob(who.workspaceId, jobId);
    if (existing === null) return { cancelled: false as const, reason: `No job ${jobId}.` };
    const job = await cancelJob(who.workspaceId, jobId);
    return {
      cancelled: true as const,
      job: job === null ? null : { id: job.id, title: job.title, status: job.status },
      note:
        existing.status === "running"
          ? "The bot may still be mid-step; use task_cancel on the running task to stop it immediately."
          : undefined,
    };
  },
});
