import { gateway } from "@ai-sdk/gateway";
import { experimental_evaluate as evaluate } from "ai";

/**
 * Jev, TypeSafe's decision model, as a function Bot can call.
 *
 * Jev takes structured state and answers typed questions with calibrated
 * probabilities, in well under a second and for a fraction of a cent. It never
 * generates text. That makes it the right tool for the many small decisions
 * inside a job that today cost a full model turn: how hard a job is, which
 * element to click next. Each decision here is a `choice` over named options
 * with a description apiece; Jev sees the state, the descriptions, and nothing
 * else, and hands back the option it picked and how sure it is.
 *
 * Every caller keeps a fallback for when Jev is off, unsure, or unreachable,
 * because a decision service is optional infrastructure, not a dependency.
 * Jev is reached through AI Gateway (`BOT_JEV_MODEL`, default `typesafe-ai/jev`),
 * so it needs the same credentials as the language models.
 */

export type JevFeature = "effort" | "pilot";

const FEATURE_ENV: Readonly<Record<JevFeature, string>> = {
  effort: "BOT_EFFORT_RATER",
  pilot: "BOT_BROWSER_PILOT",
};

const ON = new Set(["jev", "1", "on", "true"]);

/** Whether a Jev-backed decision is switched on. Each is off until asked for. */
export function jevEnabled(feature: JevFeature): boolean {
  return ON.has(process.env[FEATURE_ENV[feature]]?.trim().toLowerCase() ?? "");
}

export const jevModel = (): string => process.env.BOT_JEV_MODEL?.trim() || "typesafe-ai/jev";

/** Anything JSON-shaped the caller wants Jev to look at. */
export type JevState = string | Readonly<Record<string, unknown>> | readonly unknown[];

export interface Decision<K extends string> {
  readonly choice: K;
  /** Jev's probability for the choice it made, or null when it reported none. */
  readonly confidence: number | null;
  readonly probabilities: Readonly<Partial<Record<K, number>>> | null;
  readonly ms: number;
  readonly inputTokens: number | null;
}

/**
 * One choice. `options` maps each option key to a plain-language description
 * of when it is the right answer; the key is what comes back.
 */
export async function decide<K extends string>(input: {
  readonly state: JevState;
  readonly instructions: string;
  readonly options: Readonly<Record<K, string>>;
  readonly abortSignal?: AbortSignal;
}): Promise<Decision<K>> {
  const keys = Object.keys(input.options) as K[];
  if (keys.length < 2) throw new Error("A decision needs at least two options.");
  if (keys.length > 255) throw new Error(`Jev decides among at most 255 options; ${keys.length} given.`);

  const started = Date.now();
  const result = await evaluate({
    // Built as a Gateway model on purpose: a bare model id waits on a default
    // provider that only eve's own runtime configures, and hangs elsewhere.
    model: gateway.evaluationModel(jevModel()),
    state: input.state as Parameters<typeof evaluate>[0]["state"],
    questions: {
      pick: { type: "choice" as const, instructions: input.instructions, criteria: input.options },
    },
    maxRetries: 1,
    ...(input.abortSignal === undefined ? {} : { abortSignal: input.abortSignal }),
  });
  const answer = result.answers.pick;
  const choice = answer.choice as K;
  const probabilities = (answer.probabilities ?? null) as Readonly<Partial<Record<K, number>>> | null;
  const confidence = probabilities?.[choice];
  return {
    choice,
    confidence: typeof confidence === "number" && Number.isFinite(confidence) ? confidence : null,
    probabilities,
    ms: Date.now() - started,
    inputTokens: result.usage.inputTokens ?? null,
  };
}

/** The options Jev leaned towards, most likely first, for a tool result or a log line. */
export function ranked<K extends string>(decision: Decision<K>, top = 3): Array<{ option: K; p: number }> {
  if (decision.probabilities === null) return [{ option: decision.choice, p: decision.confidence ?? 1 }];
  return (Object.entries(decision.probabilities) as Array<[K, number]>)
    .sort((left, right) => right[1] - left[1])
    .slice(0, top)
    .map(([option, p]) => ({ option, p: Math.round(p * 1000) / 1000 }));
}
