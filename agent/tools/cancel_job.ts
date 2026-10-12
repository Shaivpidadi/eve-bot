import { defineTool } from "eve/tools";
import { z } from "zod";

import { cancelJobRun, describeInterruption } from "../lib/cancel";
import { stopRunCommands } from "../lib/computer/shell";
import { operator } from "../lib/session";

/**
 * Cancels a job from a thread, through the same `cancelJobRun` the console
 * uses. The cancel lands in one write, after which every job write and guarded
 * action the bot tries is refused, and the bot's session, which a tool has no
 * handle on in eve 0.58, makes no further model call (the teammate's `fence`
 * hook), which also ends its `run_job` run. The note says exactly what
 * happened rather than promising more.
 */
export default defineTool({
  description:
    "Stop a job and, if it repeats, stop the repetition. Work already delivered is not undone, and a finished job cannot be cancelled. Cancelling twice is harmless.",
  inputSchema: z.object({ jobId: z.string() }),
  label: { start: ({ jobId }) => `Cancel ${jobId}` },
  async execute({ jobId }, ctx) {
    const who = operator(ctx);
    const cancelled = await cancelJobRun(who.workspaceId, jobId, { stopCommands: stopRunCommands });
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
