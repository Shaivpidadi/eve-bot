import { defineTool } from "eve/tools";
import { z } from "zod";

import { record } from "../lib/activity";
import { defaultBot, findBot, hireBot, listBots } from "../lib/bots";
import { DEFAULT_BOT } from "../lib/default-bot";
import { assignJob } from "../lib/jobs";
import { DEFAULT_EFFORT, EFFORT_DESCRIPTIONS, JOB_EFFORTS, type JobEffort } from "../lib/models";
import { isRoomName } from "../lib/rooms";
import { operator } from "../lib/session";
import { briefFromRecipe, findRecipe, noteRecipeUsed } from "../lib/recipes";
import { DAYS, defaultTimezone, describeSchedule, isSchedule, nextRun, type Schedule } from "../lib/schedule";
import { looseBoolean } from "../lib/tool-input";
import type { Bot } from "../lib/types";

type Rating = { readonly effort: JobEffort; readonly by: "hq" | "default" };

/** The level HQ gave the job, or the default. A failed job re-runs one level up. */
const rateEffort = (effort: JobEffort | undefined): Rating =>
  effort === undefined ? { effort: DEFAULT_EFFORT, by: "default" } : { effort, by: "hq" };

type Pick = { readonly bot: Bot; readonly by: "named" | "default"; readonly note?: string };

/**
 * Which Bot takes a job HQ did not name one for: the generalist. An empty
 * roster brings the generalist back rather than leaving HQ to improvise a
 * teammate. Retiring it stays deliberate; needing it does not.
 */
async function pickBot(workspaceId: string): Promise<Pick> {
  const active = (await listBots(workspaceId)).filter((bot) => bot.status === "active");
  const fallback = (await defaultBot(workspaceId)) ?? active[0] ?? null;
  if (fallback !== null) return { bot: fallback, by: "default" };
  const hired = await hireBot({ workspaceId, hiredBy: "system", ...DEFAULT_BOT });
  await record({
    workspaceId,
    kind: "bot.hired",
    botId: hired.id,
    text: `${DEFAULT_BOT.emoji} ${hired.name} rejoined the team: no Bot was left to take a job.`,
  });
  return { bot: hired, by: "default", note: `No Bot was on the team, so ${hired.name}, the generalist, rejoined it to take this job.` };
}

export default defineTool({
  description:
    "Create a job for a bot. Write the brief so a teammate who has not seen this conversation could execute it. Assigning does not start the work — call run_job, or let the schedule pick it up at runAt.",
  inputSchema: z.object({
    bot: z
      .string()
      .optional()
      .describe(
        "Bot name or id. Give it when the operator named the Bot, the job is in that Bot's own thread, or a Bot's role clearly fits. Otherwise leave it out and the generalist takes it; the result says who.",
      ),
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
    // Coerced: some models send numbers as strings ("60"), and a rejected call
    // tends to be retried without the field, silently dropping the schedule.
    everyMinutes: z.coerce
      .number()
      .int()
      .min(5)
      .max(525_600)
      .nullable()
      .optional()
      .describe("Repeat interval. Omit or null for a one-off job. For a time of day, use dailyAt instead."),
    dailyAt: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .optional()
      .describe('A clock time such as "09:00" for a routine that runs at a time of day rather than on an interval. This is what "every weekday at 9" means; it does not drift when a cycle runs long.'),
    onDays: z
      .array(z.enum(DAYS))
      .max(7)
      .optional()
      .describe('Which days a dailyAt routine runs, such as ["mon","tue","wed","thu","fri"]. Omit for every day.'),
    timezone: z
      .string()
      .max(60)
      .optional()
      .describe("IANA timezone for dailyAt, such as America/New_York. Defaults to the deployment's own."),
    requiresSignoff: looseBoolean()
      .optional()
      .describe(
        "Ask a human to approve the deliverable before the job closes. Only when the operator asked to review it first, or it goes somewhere public, irreversible, or expensive. Research, analysis, files, and monitors do not need it.",
      ),
    priority: z.enum(["normal", "high"]).optional(),
    effort: z
      .enum(JOB_EFFORTS)
      .optional()
      .describe(
        `How hard the job is, which picks the model and its cost. "quick": ${EFFORT_DESCRIPTIONS.quick} "standard": ${EFFORT_DESCRIPTIONS.standard} "deep": ${EFFORT_DESCRIPTIONS.deep} Choose the lowest that will do the job well; a failed job re-runs one level up. Defaults to standard.`,
      ),
    recipe: z
      .string()
      .max(60)
      .optional()
      .describe(
        "The name of a saved recipe to brief this job from, when the request matches one. Write brief as only what is different this time.",
      ),
    room: z
      .string()
      .max(60)
      .optional()
      .describe("Where the result should be reported. Defaults to the conversation you are in."),
  }),
  label: {
    start: ({ bot, title }) => `Assign "${title}" to ${bot}`,
  },
  async execute(input, ctx) {
    const who = operator(ctx);
    let pick: Pick;
    if (input.bot !== undefined && input.bot.trim() !== "") {
      const named = await findBot(who.workspaceId, input.bot);
      if (named === null) {
        return { assigned: false as const, reason: `No bot called ${input.bot}. Leave bot out to have one picked, or hire one.` };
      }
      pick = { bot: named, by: "named" };
    } else {
      pick = await pickBot(who.workspaceId);
    }
    const bot = pick.bot;
    if (bot.status === "paused") {
      return { assigned: false as const, reason: `${bot.name} is paused. Resume it first.` };
    }
    if (input.runAt !== undefined && Number.isNaN(Date.parse(input.runAt))) {
      return { assigned: false as const, reason: `runAt must be an ISO 8601 timestamp.` };
    }

    // A request the team has done before is briefed from how it went, plus
    // whatever is different today.
    const recipe = input.recipe === undefined ? null : await findRecipe(who.workspaceId, input.recipe);
    if (input.recipe !== undefined && recipe === null) {
      return { assigned: false as const, reason: `No recipe called ${input.recipe}. Write the brief yourself, or check the name.` };
    }
    const brief = recipe === null ? input.brief : briefFromRecipe(recipe, input.brief);

    const rating = rateEffort(input.effort);

    // A clock routine: "every weekday at 9" rather than "every 1440 minutes".
    let schedule: Schedule | null = null;
    if (input.dailyAt !== undefined) {
      const [hour = "0", minute = "0"] = input.dailyAt.split(":");
      const timezone = input.timezone?.trim() || defaultTimezone();
      const candidate: unknown = {
        hour: Number(hour),
        minute: Number(minute),
        ...(input.onDays === undefined || input.onDays.length === 0 ? {} : { days: input.onDays }),
        timezone,
      };
      if (!isSchedule(candidate)) {
        return {
          assigned: false as const,
          reason: `${timezone} is not a timezone I know. Use an IANA name such as America/New_York.`,
        };
      }
      schedule = candidate;
    }

    const job = await assignJob({
      workspaceId: who.workspaceId,
      botId: bot.id,
      requestedBy: who.label,
      title: input.title,
      brief,
      ...(input.successCriteria
        ? { successCriteria: input.successCriteria }
        : recipe !== null && recipe.successCriteria.length > 0
          ? { successCriteria: [...recipe.successCriteria] }
          : {}),
      ...(input.runAt ? { runAt: input.runAt } : schedule === null ? {} : { runAt: nextRun(schedule, new Date()).toISOString() }),
      ...(input.everyMinutes !== undefined ? { everyMinutes: input.everyMinutes } : {}),
      ...(schedule === null ? {} : { schedule }),
      ...(input.requiresSignoff !== undefined ? { requiresSignoff: input.requiresSignoff } : {}),
      ...(input.priority ? { priority: input.priority } : {}),
      effort: rating.effort,
      effortBy: rating.by,
      // Report back in the thread the work was asked for in, unless told otherwise.
      room: input.room !== undefined && isRoomName(input.room) ? input.room : who.room,
    });

    if (recipe !== null) await noteRecipeUsed(who.workspaceId, recipe.id);

    return {
      assigned: true as const,
      ...(recipe === null ? {} : { recipe: recipe.name }),
      job: {
        id: job.id,
        title: job.title,
        status: job.status,
        runAt: job.runAt,
        everyMinutes: job.everyMinutes,
        ...(schedule === null ? {} : { schedule: describeSchedule(schedule) }),
        requiresSignoff: job.requiresSignoff,
        effort: job.effort,
        effortBy: rating.by,
      },
      bot: {
        id: bot.id,
        name: bot.name,
        pickedBy: pick.by,
        ...(pick.note === undefined ? {} : { note: pick.note }),
      },
      nextStep:
        job.status === "queued"
          ? `Call run_job with jobId ${job.id} to start it now.`
          : `Scheduled. The dispatcher will start it at ${job.runAt}.`,
    };
  },
});
