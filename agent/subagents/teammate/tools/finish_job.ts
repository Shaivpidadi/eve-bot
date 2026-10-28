import { defineTool } from "eve/tools";
import { z } from "zod";

import { record } from "../../../lib/activity";
import { checkpointComputer } from "../../../lib/computer-backup";
import { describeRunRefusal, patchJobAsRun } from "../../../lib/jobs";
import { operator } from "../../../lib/session";
import { readRunTabs } from "../../../lib/computer/screens";
import { effectiveEnv } from "../../../lib/settings/store";
import { browser, sessionDirectory } from "../lib/browser";
import { journal } from "../lib/journal";
import { keepJobRecording, recordingOn } from "../lib/recording";
import { looseBoolean } from "../../../lib/tool-input";
import type { JobResult } from "../../../lib/types";

/** Whether this run opened a tab of its own, which is the only way it records. */
const usedBrowser = async (workspaceId: string, sessionId: string): Promise<boolean> =>
  Object.values(await readRunTabs(workspaceId)).some((tab) => tab.sessionId === sessionId);

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

    // `verified` is the bot's own claim about its work, so it is kept with the
    // result rather than only said in the feed: everything downstream — HQ's
    // report, the operator, a later grader — needs to know which it was.
    const draft: JobResult = {
      summary: input.summary,
      deliverable: input.deliverable,
      openQuestions: input.openQuestions ?? [],
      needsHuman: input.needsHuman,
      completion: input.verified ? "verified" : "recorded",
      recordedAt: new Date().toISOString(),
    };

    // Only the job's current run may record its result, and the result names
    // that run, so run_job never takes a superseded run's words for its own.
    const written = await patchJobAsRun(who.workspaceId, input.jobId, ctx.session.id, (current, run) =>
      // Already there: a retried write that had landed (see patchJobAsRun).
      current.result?.producedBy?.session === run.session &&
      current.result.producedBy.token === run.token &&
      current.result.recordedAt === draft.recordedAt
        ? null
        : { ...current, result: { ...draft, producedBy: run } },
    );
    if (!written.ok) {
      return {
        recorded: false as const,
        reason: written.reason,
        message: describeRunRefusal(written.reason, input.jobId),
      };
    }
    const job = written.job;
    const result = job.result ?? draft;
    await journal(ctx, { kind: "progress", text: `Recorded the result (${input.verified ? "verified" : "unverified"}): ${input.summary.slice(0, 200)}` }, input.jobId);

    await record({
      workspaceId: who.workspaceId,
      kind: "job.progress",
      botId: job.botId,
      jobId: input.jobId,
      text: input.verified
        ? `Result recorded (verified): ${input.summary}`
        : `Result recorded (unverified): ${input.summary}`,
    });

    // The run's browser recording, when it made one (see `lib/recording.ts`).
    if (recordingOn(await effectiveEnv()) && (await usedBrowser(who.workspaceId, ctx.session.id))) {
      await keepJobRecording(ctx, input.jobId, await sessionDirectory(ctx), () => browser(ctx, ["record", "stop"])).catch((error: unknown) => {
        console.warn("[recording] could not keep the browser recording:", error instanceof Error ? error.message : error);
      });
    }

    // The end of a job is the natural point to keep what it left on the computer.
    await checkpointComputer(ctx, { minIntervalMs: 60_000 });
    return { recorded: true as const, result };
  },
});
