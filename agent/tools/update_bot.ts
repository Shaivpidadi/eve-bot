import { defineTool } from "eve/tools";
import { z } from "zod";

import { record } from "../lib/activity";
import { findBot, isReservedName, patchBot, RESERVED_NAME_REFUSAL, teachBot } from "../lib/bots";
import { ENGINE_LABELS, ENGINES, engineRefusal, engineChoiceOffered, type Engine } from "../lib/engines";
import { operator } from "../lib/session";
import { effectiveEnv } from "../lib/settings/store";

/**
 * Offered only where another engine can run (`BOT_ENGINES`, or a standalone
 * server's own computer for the owner's plan), so HQ's
 * tools read exactly as before everywhere else.
 */
const engineField = engineChoiceOffered()
  ? {
      engine: z
        .enum(ENGINES)
        .optional()
        .describe(
          `What runs its jobs from the next one on: ${ENGINES.map((engine) => `"${engine}" for ${ENGINE_LABELS[engine]}`).join(", ")}. Only when the person asks for it.`,
        ),
    }
  : {};

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
    ...engineField,
  }),
  label: {
    start: ({ bot }) => `Update ${bot}`,
  },
  async execute(input, ctx) {
    const who = operator(ctx);
    const found = await findBot(who.workspaceId, input.bot);
    if (found === null) return { updated: false as const, reason: `No bot called ${input.bot}.` };
    if (input.name !== undefined) {
      if (isReservedName(input.name)) return { updated: false as const, reason: RESERVED_NAME_REFUSAL };
      // Bots are addressed by name, so two with the same name would be ambiguous.
      const clash = await findBot(who.workspaceId, input.name);
      if (clash !== null && clash.id !== found.id) {
        return { updated: false as const, reason: `${clash.name} is already on the team.` };
      }
    }

    const engine = (input as { engine?: Engine }).engine;
    if (engine !== undefined) {
      const refused = engineRefusal(engine, { workspaceId: who.workspaceId, env: await effectiveEnv(who.workspaceId) });
      if (refused !== null) return { updated: false as const, reason: refused };
    }

    const updated = await patchBot(who.workspaceId, found.id, (bot) => ({
      ...bot,
      name: input.name ?? bot.name,
      role: input.role ?? bot.role,
      persona: input.persona ?? bot.persona,
      emoji: input.emoji ?? bot.emoji,
      skills: input.skills ?? bot.skills,
      status: input.status ?? bot.status,
      ...(engine === undefined ? {} : { engine }),
    }));

    const taught =
      input.lesson === undefined ? updated : await teachBot(who.workspaceId, found.id, input.lesson);

    await record({
      workspaceId: who.workspaceId,
      kind: "bot.updated",
      botId: found.id,
      text:
        input.lesson !== undefined
          ? `${found.name} learned: ${input.lesson}`
          : engine !== undefined
            ? `${found.name} now runs on ${ENGINE_LABELS[engine]}.`
            : `${found.name} was updated.`,
    });

    return { updated: true as const, bot: taught };
  },
});
