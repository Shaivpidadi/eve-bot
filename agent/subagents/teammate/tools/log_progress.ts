import { defineTool } from "eve/tools";
import { z } from "zod";

import { record } from "../../../lib/activity";
import { checkpointComputer } from "../../../lib/computer-backup";
import { getJob } from "../../../lib/jobs";
import { operator } from "../../../lib/session";

export default defineTool({
  description:
    "Record one meaningful step you just took, in the operator's words. This is the log a person reads to see what you did while they were away, so write it for them, not for yourself.",
  inputSchema: z.object({
    jobId: z.string(),
    note: z.string().min(3).max(400).describe("One line: what you did and what came of it."),
    detail: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
      .optional()
      .describe("Optional structured context: a URL, a record id, a count."),
  }),
  label: { start: ({ note }) => note.slice(0, 80) },
  async execute({ jobId, note, detail }, ctx) {
    const who = operator(ctx);
    const job = await getJob(who.workspaceId, jobId);
    await record({
      workspaceId: who.workspaceId,
      kind: "job.progress",
      jobId,
      botId: job?.botId ?? null,
      text: note,
      ...(detail ? { data: detail } : {}),
    });
    // Throttled inside: most progress notes do not trigger a backup.
    await checkpointComputer(ctx);
    return { logged: true as const };
  },
});
