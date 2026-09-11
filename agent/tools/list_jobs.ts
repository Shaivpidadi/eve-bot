import { defineTool } from "eve/tools";
import { z } from "zod";

import { findBot, listBots } from "../lib/bots";
import { listJobs } from "../lib/jobs";
import { operator } from "../lib/session";

const STATUS = z.enum([
  "scheduled",
  "queued",
  "dispatched",
  "running",
  "blocked",
  "done",
  "failed",
  "cancelled",
]);

export default defineTool({
  description: "List jobs across the team, newest first. Filter by bot or status.",
  inputSchema: z.object({
    bot: z.string().optional().describe("Bot name or id."),
    status: z.array(STATUS).max(8).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  }),
  label: { start: ({ bot }) => (bot ? `List ${bot}'s jobs` : "List jobs") },
  async execute(input, ctx) {
    const who = operator(ctx);
    const bot = input.bot ? await findBot(who.workspaceId, input.bot) : null;
    if (input.bot !== undefined && bot === null) {
      return { jobs: [], reason: `No bot called ${input.bot}.` };
    }
    const [jobs, bots] = await Promise.all([
      listJobs(who.workspaceId, {
        ...(bot ? { botId: bot.id } : {}),
        ...(input.status ? { status: input.status } : {}),
        ...(input.limit ? { limit: input.limit } : {}),
      }),
      listBots(who.workspaceId),
    ]);
    const names = new Map(bots.map((entry) => [entry.id, entry.name]));
    return {
      jobs: jobs.map((job) => ({
        id: job.id,
        title: job.title,
        bot: names.get(job.botId) ?? job.botId,
        status: job.status,
        runAt: job.runAt,
        everyMinutes: job.everyMinutes,
        attempts: job.attempts,
        summary: job.result?.summary ?? job.error ?? null,
      })),
    };
  },
});
