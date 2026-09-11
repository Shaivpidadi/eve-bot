import { defineTool } from "eve/tools";
import { z } from "zod";

import { record } from "../lib/activity";
import { findBot, patchBot, teachBot } from "../lib/bots";
import { operator } from "../lib/session";

export default defineTool({
  description:
    "Change a bot: rename it, rewrite its persona, pause or resume it, or teach it something it should remember on every future job.",
  inputSchema: z.object({
    bot: z.string().describe("Bot name or id."),
    name: z.string().min(1).max(40).optional(),
    role: z.string().min(1).max(120).optional(),
    persona: z.string().min(20).max(4_000).optional(),
    emoji: z.string().max(8).optional(),
    skills: z.array(z.string().max(40)).max(12).optional(),
    status: z.enum(["active", "paused"]).optional(),
    lesson: z
      .string()
      .max(400)
      .optional()
      .describe("A durable lesson to add to the bot's playbook, in one sentence."),
  }),
  label: {
    start: ({ bot }) => `Update ${bot}`,
  },
  async execute(input, ctx) {
    const who = operator(ctx);
    const found = await findBot(who.workspaceId, input.bot);
    if (found === null) return { updated: false as const, reason: `No bot called ${input.bot}.` };
    if (input.name !== undefined) {
      // Bots are addressed by name, so two with the same name would be ambiguous.
      const clash = await findBot(who.workspaceId, input.name);
      if (clash !== null && clash.id !== found.id) {
        return { updated: false as const, reason: `${clash.name} is already on the team.` };
      }
    }

    const updated = await patchBot(who.workspaceId, found.id, (bot) => ({
      ...bot,
      name: input.name ?? bot.name,
      role: input.role ?? bot.role,
      persona: input.persona ?? bot.persona,
      emoji: input.emoji ?? bot.emoji,
      skills: input.skills ?? bot.skills,
      status: input.status ?? bot.status,
    }));

    const taught =
      input.lesson === undefined ? updated : await teachBot(who.workspaceId, found.id, input.lesson);

    await record({
      workspaceId: who.workspaceId,
      kind: "bot.updated",
      botId: found.id,
      text:
        input.lesson === undefined
          ? `${found.name} was updated.`
          : `${found.name} learned: ${input.lesson}`,
    });

    return { updated: true as const, bot: taught };
  },
});
