import { defineTool } from "eve/tools";
import { z } from "zod";

import { recentActivity } from "../lib/activity";
import { getBot } from "../lib/bots";
import { getJob } from "../lib/jobs";
import { operator } from "../lib/session";

export default defineTool({
  description:
    "Read one job in full: its brief, current status, result, artifacts, and the steps the bot logged along the way.",
  inputSchema: z.object({ jobId: z.string() }),
  label: { start: ({ jobId }) => `Check ${jobId}` },
  async execute({ jobId }, ctx) {
    const who = operator(ctx);
    const job = await getJob(who.workspaceId, jobId);
    if (job === null) return { found: false as const, reason: `No job ${jobId}.` };
    const [bot, activity] = await Promise.all([
      getBot(who.workspaceId, job.botId),
      recentActivity(who.workspaceId, { jobId, limit: 20 }),
    ]);
    return {
      found: true as const,
      job,
      bot: bot === null ? null : { id: bot.id, name: bot.name, emoji: bot.emoji },
      timeline: activity.map((event) => ({ at: event.at, kind: event.kind, text: event.text })),
    };
  },
});
