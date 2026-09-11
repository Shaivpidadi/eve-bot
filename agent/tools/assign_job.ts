import { defineTool } from "eve/tools";
import { z } from "zod";

import { findBot } from "../lib/bots";
import { assignJob } from "../lib/jobs";
import { operator } from "../lib/session";

export default defineTool({
  description:
    "Create a job for a bot. Write the brief so a teammate who has not seen this conversation could execute it. Assigning does not start the work — call run_job, or let the schedule pick it up at runAt.",
  inputSchema: z.object({
    bot: z.string().describe("Bot name or id."),
    title: z.string().min(1).max(120),
    brief: z
      .string()
      .min(10)
      .max(8_000)
      .describe("Everything the bot needs: accounts, URLs, names, tone, and where the work lands."),
    successCriteria: z
      .array(z.string().max(200))
      .max(10)
      .optional()
      .describe("Checkable statements that define done."),
    runAt: z
      .string()
      .optional()
      .describe("ISO 8601 timestamp with offset for the first run. Defaults to now."),
    everyMinutes: z
      .number()
      .int()
      .min(5)
      .max(525_600)
      .nullable()
      .optional()
      .describe("Repeat interval. Omit or null for a one-off job."),
    requiresSignoff: z
      .boolean()
      .optional()
      .describe("Ask a human to approve the deliverable before the job closes."),
    priority: z.enum(["normal", "high"]).optional(),
    room: z
      .string()
      .max(60)
      .optional()
      .describe("Where the result should be reported. Defaults to the operator's desk."),
  }),
  label: {
    start: ({ bot, title }) => `Assign "${title}" to ${bot}`,
  },
  async execute(input, ctx) {
    const who = operator(ctx);
    const bot = await findBot(who.workspaceId, input.bot);
    if (bot === null) {
      return { assigned: false as const, reason: `No bot called ${input.bot}. Hire one first.` };
    }
    if (bot.status === "paused") {
      return { assigned: false as const, reason: `${bot.name} is paused. Resume it first.` };
    }
    if (input.runAt !== undefined && Number.isNaN(Date.parse(input.runAt))) {
      return { assigned: false as const, reason: `runAt must be an ISO 8601 timestamp.` };
    }

    const job = await assignJob({
      workspaceId: who.workspaceId,
      botId: bot.id,
      requestedBy: who.label,
      title: input.title,
      brief: input.brief,
      ...(input.successCriteria ? { successCriteria: input.successCriteria } : {}),
      ...(input.runAt ? { runAt: input.runAt } : {}),
      ...(input.everyMinutes !== undefined ? { everyMinutes: input.everyMinutes } : {}),
      ...(input.requiresSignoff !== undefined ? { requiresSignoff: input.requiresSignoff } : {}),
      ...(input.priority ? { priority: input.priority } : {}),
      ...(input.room ? { room: input.room } : {}),
    });

    return {
      assigned: true as const,
      job: {
        id: job.id,
        title: job.title,
        status: job.status,
        runAt: job.runAt,
        everyMinutes: job.everyMinutes,
        requiresSignoff: job.requiresSignoff,
      },
      bot: { id: bot.id, name: bot.name },
      nextStep:
        job.status === "queued"
          ? `Call run_job with jobId ${job.id} to start it now.`
          : `Scheduled. The dispatcher will start it at ${job.runAt}.`,
    };
  },
});
