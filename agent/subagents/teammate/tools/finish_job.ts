import { defineTool } from "eve/tools";
import { z } from "zod";

import { record } from "../../../lib/activity";
import { checkpointComputer } from "../../../lib/computer-backup";
import { getJob, patchJob } from "../../../lib/jobs";
import { operator } from "../../../lib/session";
import { looseBoolean } from "../../../lib/tool-input";
import type { JobResult } from "../../../lib/types";

export default defineTool({
  description:
    "Record the outcome of the job. Call this once, at the end, then return the same fields as your final answer. Status transitions and sign-off are handled by the dispatcher — your part is an honest result.",
  inputSchema: z.object({
    jobId: z.string(),
    summary: z.string().min(5).max(600).describe("What happened, for a busy person."),
    deliverable: z
      .string()
      .min(1)
      .max(8_000)
      .describe("The output itself, or exactly where it now lives."),
    openQuestions: z.array(z.string().max(300)).max(10).optional(),
    needsHuman: looseBoolean()
      .describe(
        "True only when the job cannot count as done until a person acts: they skipped a takeover you needed, or a decision only they can make blocks the deliverable. Open questions alone are not a reason; put them in openQuestions.",
      ),
    verified: looseBoolean()
      .describe("True only if you re-checked the result after acting, rather than assuming it."),
  }),
  label: { start: ({ summary }) => `Finish: ${summary.slice(0, 60)}` },
  async execute(input, ctx) {
    const who = operator(ctx);
    const job = await getJob(who.workspaceId, input.jobId);
    if (job === null) return { recorded: false as const, reason: `No job ${input.jobId}.` };

    // `verified` is the bot's own claim about its work, so it is kept with the
    // result rather than only said in the feed: everything downstream — HQ's
    // report, the operator, a later grader — needs to know which it was.
    const result: JobResult = {
      summary: input.summary,
      deliverable: input.deliverable,
      openQuestions: input.openQuestions ?? [],
      needsHuman: input.needsHuman,
      completion: input.verified ? "verified" : "recorded",
    };

    await patchJob(who.workspaceId, input.jobId, (current) => ({ ...current, result }));
    await record({
      workspaceId: who.workspaceId,
      kind: "job.progress",
      botId: job.botId,
      jobId: input.jobId,
      text: input.verified
        ? `Result recorded (verified): ${input.summary}`
        : `Result recorded (unverified): ${input.summary}`,
    });

    // The end of a job is the natural point to keep what it left on the computer.
    await checkpointComputer(ctx, { minIntervalMs: 60_000 });
    return { recorded: true as const, result };
  },
});
