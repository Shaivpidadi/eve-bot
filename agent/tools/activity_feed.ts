import { defineTool } from "eve/tools";
import { z } from "zod";

import { recentActivity } from "../lib/activity";
import { findBot, listBots } from "../lib/bots";
import { operator } from "../lib/session";

export default defineTool({
  description:
    "Read what the team has been doing: hires, assignments, progress, approvals, results and failures, newest first. Use this to answer 'what happened while I was away'.",
  inputSchema: z.object({
    bot: z.string().optional().describe("Bot name or id."),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  }),
  label: { start: () => "Read the activity feed" },
  async execute(input, ctx) {
    const who = operator(ctx);
    const bot = input.bot ? await findBot(who.workspaceId, input.bot) : null;
    const [events, bots] = await Promise.all([
      recentActivity(who.workspaceId, {
        ...(bot ? { botId: bot.id } : {}),
        ...(input.limit ? { limit: input.limit } : {}),
      }),
      listBots(who.workspaceId),
    ]);
    const names = new Map(bots.map((entry) => [entry.id, entry.name]));
    return {
      events: events.map((event) => ({
        at: event.at,
        kind: event.kind,
        bot: event.botId === null ? null : (names.get(event.botId) ?? event.botId),
        jobId: event.jobId,
        text: event.text,
      })),
    };
  },
});
