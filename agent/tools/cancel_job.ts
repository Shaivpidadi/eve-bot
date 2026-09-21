import { defineTool } from "eve/tools";
import { z } from "zod";

import { cancelJob } from "../lib/jobs";
import { operator } from "../lib/session";

export default defineTool({
  description:
    "Stop a job and, if it repeats, stop the repetition. Work already delivered is not undone, and a finished job cannot be cancelled.",
  inputSchema: z.object({ jobId: z.string() }),
  label: { start: ({ jobId }) => `Cancel ${jobId}` },
  async execute({ jobId }, ctx) {
    const who = operator(ctx);
    const cancelled = await cancelJob(who.workspaceId, jobId);
    if (!cancelled.ok) return { cancelled: false as const, reason: cancelled.reason };
    return {
      cancelled: true as const,
      job: { id: cancelled.job.id, title: cancelled.job.title, status: cancelled.job.status },
      note: cancelled.wasRunning
        ? "The bot may finish its current step before it notices; the job stays cancelled and nothing more starts. Do not cancel the task underneath."
        : undefined,
    };
  },
});
