import { defineTool } from "eve/tools";
import { z } from "zod";

import { findBot, getBot, hireBot } from "../../../lib/bots";
import { getJob } from "../../../lib/jobs";
import { operator } from "../../../lib/session";

export default defineTool({
  description:
    "Add a new Bot to the team. Use it only when the operator or your job explicitly asks for a new Bot — never on your own initiative, and never to hand off your own job. The new Bot is an independent teammate: give it a sharp role and a persona that says how it works, what it must never do, and what good output looks like.",
  inputSchema: z.object({
    jobId: z.string().describe("The job that asked for the new Bot."),
    name: z.string().min(1).max(40).describe("First name, as a person would say it: Ava, Milo."),
    role: z.string().min(1).max(120).describe("One line: what this Bot is for."),
    persona: z
      .string()
      .min(20)
      .max(4_000)
      .describe("Standing instructions: how it works, what it must never do, what good output looks like."),
    emoji: z.string().max(8).optional(),
    skills: z.array(z.string().max(40)).max(12).optional(),
  }),
  label: { start: ({ name, role }) => `Create ${name} — ${role}` },
  async execute(input, ctx) {
    const who = operator(ctx);
    const job = await getJob(who.workspaceId, input.jobId);
    if (job === null) return { created: false as const, reason: `No job ${input.jobId}.` };

    const existing = await findBot(who.workspaceId, input.name);
    if (existing !== null) {
      return {
        created: false as const,
        reason: `${existing.name} is already on the team. Use a different name, or tell the operator.`,
        bot: { id: existing.id, name: existing.name, role: existing.role },
      };
    }

    const creator = await getBot(who.workspaceId, job.botId);
    const bot = await hireBot({
      workspaceId: who.workspaceId,
      hiredBy: who.id,
      name: input.name,
      role: input.role,
      persona: input.persona,
      ...(input.emoji ? { emoji: input.emoji } : {}),
      ...(input.skills ? { skills: input.skills } : {}),
      ...(creator === null ? {} : { createdBy: { botId: creator.id, name: creator.name } }),
    });
    return { created: true as const, bot: { id: bot.id, name: bot.name, role: bot.role } };
  },
});
