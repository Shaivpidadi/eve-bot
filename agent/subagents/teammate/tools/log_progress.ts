import { defineTool } from "eve/tools";
import { z } from "zod";

import { record } from "../../../lib/activity";
import { checkpointComputer } from "../../../lib/computer-backup";
import { guardSideEffect } from "../../../lib/run-guard";
import { operator } from "../../../lib/session";
import { journal } from "../lib/journal";

export default defineTool({
  description:
    "Record one meaningful step you just took, in the operator's words. This is the log a person reads to see what you did while they were away, so write it for them, not for yourself. Use kind \"decision\" when you change plan or skip a step on purpose, and say why: a run that picks this job up after a restart reads decisions first.",
  inputSchema: z.object({
    jobId: z.string(),
    note: z.string().min(3).max(400).describe("One line: what you did and what came of it, or for a decision, what you chose and why."),
    kind: z.enum(["progress", "decision"]).optional().describe('"decision" for a change of plan or a step skipped on purpose; "progress" (the default) for everything else.'),
    detail: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
      .optional()
      .describe("Optional structured context: a URL, a record id, a count."),
  }),
  label: { start: ({ note }) => note.slice(0, 80) },
  async execute({ jobId, note, kind, detail }, ctx) {
    const who = operator(ctx);
    // A superseded run's notes would read as the live run's in the job's feed.
    const run = await guardSideEffect(ctx, jobId);
    if (!run.ok) {
      return { logged: false as const, reason: run.reason, message: run.message };
    }
    await record({
      workspaceId: who.workspaceId,
      kind: "job.progress",
      jobId,
      botId: run.job.botId,
      text: kind === "decision" ? `Decided: ${note}` : note,
      ...(detail ? { data: detail } : {}),
    });
    await journal(ctx, { kind: kind ?? "progress", text: note, ...(detail ? { data: detail } : {}) }, jobId);
    // Throttled inside: most progress notes do not trigger a backup.
    await checkpointComputer(ctx);
    return { logged: true as const };
  },
});
