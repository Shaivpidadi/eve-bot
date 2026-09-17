import { defineTool } from "eve/tools";
import { z } from "zod";

import { defaultBot, findBot, listBots } from "../lib/bots";
import { decide, jevOn, ranked } from "../lib/jev";
import { assignJob } from "../lib/jobs";
import { DEFAULT_EFFORT, EFFORT_DESCRIPTIONS, JOB_EFFORTS, type JobEffort } from "../lib/models";
import { isRoomName } from "../lib/rooms";
import { operator } from "../lib/session";
import { looseBoolean } from "../lib/tool-input";
import type { Bot } from "../lib/types";

/**
 * How sure Jev must be before its rating stands. Below this the job takes
 * HQ's rating, or the default, and the tool result says why.
 */
const RATER_MIN_CONFIDENCE = 0.55;
const BRIEF_STATE_CHARS = 6_000;

type Rating = {
  readonly effort: JobEffort;
  readonly by: "hq" | "jev" | "default";
  readonly confidence?: number;
  readonly note?: string;
};

/**
 * Rates a job's effort from the brief with Jev, when the rater is on.
 *
 * HQ used to reason about the level on every assignment. A three-way choice
 * from a brief is what a decision model is for: it reads the job as structured
 * state and answers with a level and a probability. HQ may still pass a level;
 * a confident rating from Jev overrides it, and the disagreement is reported so
 * it shows up in the thread. When Jev is off, unsure, or unreachable, the job
 * keeps HQ's level, or the default.
 */
async function rateEffort(
  input: {
    readonly title: string;
    readonly brief: string;
    readonly successCriteria?: readonly string[];
    readonly everyMinutes?: number | null;
    readonly requiresSignoff?: boolean;
    readonly effort?: JobEffort;
  },
  bot: Bot,
  abortSignal: AbortSignal | undefined,
): Promise<Rating> {
  const fallback: Rating =
    input.effort === undefined ? { effort: DEFAULT_EFFORT, by: "default" } : { effort: input.effort, by: "hq" };
  if (!jevOn()) return fallback;

  try {
    const decision = await decide<JobEffort>({
      state: {
        job: {
          title: input.title,
          brief: input.brief.slice(0, BRIEF_STATE_CHARS),
          successCriteria: input.successCriteria ?? [],
          recurring: (input.everyMinutes ?? null) !== null,
          everyMinutes: input.everyMinutes ?? null,
          needsHumanSignoff: input.requiresSignoff === true,
        },
        bot: { name: bot.name, role: bot.role },
        ...(input.effort === undefined ? {} : { hqSuggested: input.effort }),
      },
      instructions:
        "Rate how hard this job is for an AI teammate working in a browser and a shell. Pick the lowest level that will do the job well: a job rated too low fails once and re-runs a level up, a job rated too high wastes money on every step. Judge from the brief and success criteria, not from the title alone.",
      options: EFFORT_DESCRIPTIONS,
      ...(abortSignal === undefined ? {} : { abortSignal }),
    });
    const confidence = decision.confidence ?? 1;
    if (confidence < RATER_MIN_CONFIDENCE) {
      return {
        ...fallback,
        note: `Jev leaned ${ranked(decision)
          .map((entry) => `${entry.option} ${Math.round(entry.p * 100)}%`)
          .join(", ")} but was not sure enough; kept ${fallback.by === "hq" ? "your" : "the default"} level.`,
      };
    }
    const note =
      input.effort !== undefined && input.effort !== decision.choice
        ? `Jev rated this ${decision.choice} (${Math.round(confidence * 100)}%) where you said ${input.effort}; the job runs as ${decision.choice}.`
        : undefined;
    return { effort: decision.choice, by: "jev", confidence, ...(note === undefined ? {} : { note }) };
  } catch (error) {
    console.warn(`[bot] effort rater unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return { ...fallback, note: "The effort rater did not answer; the job keeps the level it was given." };
  }
}

/** How sure Jev must be before its pick of Bot stands; below this the generalist takes the job. */
const PICKER_MIN_CONFIDENCE = 0.5;
const PERSONA_STATE_CHARS = 400;

type Pick = { readonly bot: Bot; readonly by: "named" | "jev" | "default"; readonly confidence?: number; readonly note?: string };

/**
 * Which Bot takes a job HQ did not name one for.
 *
 * With one active Bot there is nothing to decide. With more, Jev reads the job
 * and every active Bot's job description and picks; the generalist takes it
 * when Jev is unsure or does not answer. HQ used to decide this in prose and,
 * left to itself, tended to hire a new Bot for a one-off instead.
 */
async function pickBot(
  workspaceId: string,
  job: { readonly title: string; readonly brief: string; readonly successCriteria?: readonly string[] },
  abortSignal: AbortSignal | undefined,
): Promise<Pick | null> {
  const active = (await listBots(workspaceId)).filter((bot) => bot.status === "active");
  const fallback = (await defaultBot(workspaceId)) ?? active[0] ?? null;
  if (fallback === null) return null;
  if (active.length < 2 || !jevOn()) return { bot: fallback, by: "default" };

  try {
    const options = Object.fromEntries(
      active.map((bot) => [bot.id, `${bot.name}: ${bot.role}. ${bot.persona.slice(0, PERSONA_STATE_CHARS)}`]),
    ) as Record<string, string>;
    const decision = await decide<string>({
      state: { job: { title: job.title, brief: job.brief.slice(0, BRIEF_STATE_CHARS), successCriteria: job.successCriteria ?? [] } },
      instructions:
        "Pick the teammate whose job description fits this work best. A specialist whose role matches wins over a generalist; when no role matches, pick the generalist rather than stretching a specialist. Judge from the brief, not the title alone.",
      options,
      ...(abortSignal === undefined ? {} : { abortSignal }),
    });
    const chosen = active.find((bot) => bot.id === decision.choice);
    const confidence = decision.confidence ?? 1;
    if (chosen === undefined || confidence < PICKER_MIN_CONFIDENCE) {
      return {
        bot: fallback,
        by: "default",
        note: `Jev leaned ${ranked(decision)
          .map((entry) => `${active.find((bot) => bot.id === entry.option)?.name ?? entry.option} ${Math.round(entry.p * 100)}%`)
          .join(", ")} but was not sure enough; ${fallback.name} takes it.`,
      };
    }
    return { bot: chosen, by: "jev", confidence };
  } catch (error) {
    console.warn(`[bot] bot picker unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return { bot: fallback, by: "default", note: `The Bot picker did not answer; ${fallback.name} takes it.` };
  }
}

export default defineTool({
  description:
    "Create a job for a bot. Write the brief so a teammate who has not seen this conversation could execute it. Assigning does not start the work — call run_job, or let the schedule pick it up at runAt.",
  inputSchema: z.object({
    bot: z
      .string()
      .optional()
      .describe(
        "Bot name or id. Give it only when the operator named the Bot, or the job is in that Bot's own thread. Otherwise leave it out: the teammate whose job fits best is picked from the roster, and the result says who.",
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
      .describe("Repeat interval. Omit or null for a one-off job."),
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
        `How hard the job is, which picks the model and its cost. "quick": ${EFFORT_DESCRIPTIONS.quick} "standard": ${EFFORT_DESCRIPTIONS.standard} "deep": ${EFFORT_DESCRIPTIONS.deep} Choose the lowest that will do the job well; a failed job re-runs one level up. Optional: when the effort rater is on, the level is rated from the brief and the result says which was used.`,
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
      const picked = await pickBot(who.workspaceId, input, ctx.abortSignal);
      if (picked === null) return { assigned: false as const, reason: "There is no Bot on the team. Hire one first." };
      pick = picked;
    }
    const bot = pick.bot;
    if (bot.status === "paused") {
      return { assigned: false as const, reason: `${bot.name} is paused. Resume it first.` };
    }
    if (input.runAt !== undefined && Number.isNaN(Date.parse(input.runAt))) {
      return { assigned: false as const, reason: `runAt must be an ISO 8601 timestamp.` };
    }

    const rating = await rateEffort(input, bot, ctx.abortSignal);

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
      effort: rating.effort,
      effortBy: rating.by,
      ...(rating.confidence === undefined ? {} : { effortConfidence: rating.confidence }),
      // Report back in the thread the work was asked for in, unless told otherwise.
      room: input.room !== undefined && isRoomName(input.room) ? input.room : who.room,
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
        effort: job.effort,
        effortRatedBy: rating.by,
        ...(rating.confidence === undefined ? {} : { effortConfidence: Math.round(rating.confidence * 100) / 100 }),
        ...(rating.note === undefined ? {} : { effortNote: rating.note }),
      },
      bot: {
        id: bot.id,
        name: bot.name,
        pickedBy: pick.by,
        ...(pick.confidence === undefined ? {} : { confidence: Math.round(pick.confidence * 100) / 100 }),
        ...(pick.note === undefined ? {} : { note: pick.note }),
      },
      nextStep:
        job.status === "queued"
          ? `Call run_job with jobId ${job.id} to start it now.`
          : `Scheduled. The dispatcher will start it at ${job.runAt}.`,
    };
  },
});
