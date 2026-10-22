import { defineTool } from "eve/tools";
import { z } from "zod";

import { findBot, getBot, hireBot, isReservedName, RESERVED_NAME_REFUSAL } from "../lib/bots";
import { ENGINE_LABELS, ENGINES, type Engine, engineRefusal, engineChoiceOffered } from "../lib/engines";
import { operator } from "../lib/session";
import { effectiveEnv } from "../lib/settings/store";
import { writeIntro } from "../lib/intro";
import { within } from "../lib/cancel";

/**
 * Offered only where another engine can run (`BOT_ENGINES`, or a standalone
 * server's own computer for the owner's plan), so HQ's
 * tools read exactly as before everywhere else. Every Bot runs on eve unless
 * the person asks for another.
 */
const engineField = engineChoiceOffered()
  ? {
      engine: z
        .enum(ENGINES)
        .optional()
        .describe(
          `What runs its jobs: ${ENGINES.map((engine) => `"${engine}" for ${ENGINE_LABELS[engine]}`).join(", ")}. Leave it out for eve; only when the person asks for another.`,
        ),
    }
  : {};

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
    ...engineField,
  }),
  label: {
    start: ({ name, role }) => `Hire ${name} — ${role}`,
  },
  async execute(input, ctx) {
    const who = operator(ctx);
    if (isReservedName(input.name)) return { hired: false as const, reason: `${RESERVED_NAME_REFUSAL} Pick another name.` };
    const existing = await findBot(who.workspaceId, input.name);
    if (existing !== null) {
      return {
        hired: false as const,
        reason: `${existing.name} is already on the team (${existing.id}). Update that bot instead of hiring a duplicate.`,
        bot: existing,
      };
    }
    const engine = (input as { engine?: Engine }).engine;
    if (engine !== undefined) {
      const refused = engineRefusal(engine, { workspaceId: who.workspaceId, env: await effectiveEnv(who.workspaceId) });
      if (refused !== null) return { hired: false as const, reason: refused };
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
      ...(engine === undefined ? {} : { engine }),
      ...(creator === null ? {} : { createdBy: { botId: creator.id, name: creator.name } }),
    });
    // Its hello and first jobs for its empty thread; a slow or failed write never holds up the hire.
    await within(writeIntro(bot), 15_000).catch((error: unknown) => console.warn(`[bot] no intro for ${bot.name}: ${error instanceof Error ? error.message : String(error)}`));
    return { hired: true as const, bot };
  },
});
