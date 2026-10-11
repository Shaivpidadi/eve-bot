import { defineTool } from "eve/tools";
import { z } from "zod";

import { cancelJobRun, describeInterruption } from "../lib/cancel";
import { operator } from "../lib/session";

/**
 * Cancels a job from a thread, through the same `cancelJobRun` the console
 * uses. A tool has no handle on another session in eve 0.58, so this cancels
 * durably without interrupting the bot's session: the cancel lands in one
 * write, after which every job write and guarded action the bot tries is
 * refused, and its run ends at the parent's next heartbeat. The note says
 * exactly that rather than promising more.
 */
export default defineTool({
  description:
    "Stop a job and, if it repeats, stop the repetition. Work already delivered is not undone, and a finished job cannot be cancelled. Cancelling twice is harmless.",
  inputSchema: z.object({ jobId: z.string() }),
  label: { start: ({ jobId }) => `Cancel ${jobId}` },
  async execute({ jobId }, ctx) {
    const who = operator(ctx);
    const cancelled = await cancelJobRun(who.workspaceId, jobId);
    if (!cancelled.ok) return { cancelled: false as const, reason: cancelled.reason };
    return {
      cancelled: true as const,
      job: { id: cancelled.job.id, title: cancelled.job.title, status: cancelled.job.status },
      ...(cancelled.alreadyCancelled ? { alreadyCancelled: true as const } : {}),
      interruption: cancelled.interruption,
      note:
        cancelled.wasRunning || cancelled.session !== null
          ? `The job is cancelled and nothing more starts for it. ${describeInterruption(cancelled)} Do not cancel the task underneath.`
          : undefined,
    };
  },
});
