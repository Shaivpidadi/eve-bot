import { defineTool } from "eve/tools";
import { z } from "zod";

import { record } from "../../../lib/activity";
import { getBot, teachBot } from "../../../lib/bots";
import { getJob } from "../../../lib/jobs";
import { operator } from "../../../lib/session";

export default defineTool({
  description:
    "Write a durable lesson into your playbook. It is replayed into every future briefing, so record rules that will still be true next month — not facts about this one job.",
  inputSchema: z.object({
    jobId: z.string(),
    lesson: z
      .string()
      .min(10)
      .max(300)
      .describe("One sentence, phrased as a rule: 'Export the report as CSV; the PDF loses rows.'"),
  }),
  label: { start: ({ lesson }) => `Learn: ${lesson.slice(0, 60)}` },
  async execute({ jobId, lesson }, ctx) {
    const who = operator(ctx);
    const job = await getJob(who.workspaceId, jobId);
    if (job === null) return { learned: false as const, reason: `No job ${jobId}.` };

    const bot = await teachBot(who.workspaceId, job.botId, lesson);
    if (bot === null) return { learned: false as const, reason: "That bot is no longer on the roster." };

    await record({
      workspaceId: who.workspaceId,
      kind: "job.learned",
      botId: bot.id,
      jobId,
      text: `${bot.name} learned: ${lesson}`,
    });
    return { learned: true as const, playbookSize: bot.playbook.length };
  },
});
