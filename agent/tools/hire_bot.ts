import { defineTool } from "eve/tools";
import { z } from "zod";

import { findBot, getBot, hireBot } from "../lib/bots";
import { operator } from "../lib/session";

export default defineTool({
  description:
    "Add a new teammate to the roster. Give it a name, a role, and a persona describing how it should work. Use this when no existing bot fits the work, or whenever the operator asks for a new Bot — in a Bot's own thread, that Bot is recorded as the creator.",
  inputSchema: z.object({
    name: z.string().min(1).max(40).describe("First name, as a person would say it: Ava, Milo."),
    role: z.string().min(1).max(120).describe("One line: what this bot is for."),
    persona: z
      .string()
      .min(20)
      .max(4_000)
      .describe(
        "Standing instructions: how it works, what it must never do, what good output looks like.",
      ),
    emoji: z.string().max(8).optional(),
    skills: z.array(z.string().max(40)).max(12).optional(),
  }),
  label: {
    start: ({ name, role }) => `Hire ${name} — ${role}`,
  },
  async execute(input, ctx) {
    const who = operator(ctx);
    const existing = await findBot(who.workspaceId, input.name);
    if (existing !== null) {
      return {
        hired: false as const,
        reason: `${existing.name} is already on the team (${existing.id}). Update that bot instead of hiring a duplicate.`,
        bot: existing,
      };
    }
    // In a Bot's own thread, the operator is asking that Bot to grow the team.
    const creator = who.botId === null ? null : await getBot(who.workspaceId, who.botId);
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
    return { hired: true as const, bot };
  },
});
