import { experimental_evaluate as evaluate, type Experimental_EvaluationQuestion as EvaluationQuestion } from "ai";

/**
 * Jev: small decisions, for a tenth of a cent.
 *
 * Some of the things a Bot system needs to know are not writing tasks at all.
 * Is this page a sign-in wall? Is this run going in circles? Does this result
 * actually meet the brief? A language model can answer those, slowly and for
 * real money; a decision model answers them as a typed choice, a score, or a
 * probability, and charges for the input alone.
 *
 * It runs on AI Gateway, and this deployment may not have one — the whole
 * point of `BOT_MODEL_BASE_URL` is that Bot runs on your own models. So every
 * use of this module is optional by construction: `judge` returns null when
 * Jev is switched off, unreachable, unsure, or slow, and each caller must have
 * something sensible to do with null. That is the condition for Jev being here
 * at all, and it is why the old one was removed.
 *
 * `BOT_JEV=off` turns it off outright. `BOT_JEV_MODEL` names another model,
 * and `BOT_JEV_CONFIDENCE` is how concentrated an answer must be before a
 * caller may act on it.
 */

export const DEFAULT_MODEL = "typesafe-ai/jev";
const DEFAULT_CONFIDENCE = 0.6;
const DEFAULT_TIMEOUT_MS = 8_000;

type Env = Readonly<Record<string, string | undefined>>;

const off = (value: string | undefined): boolean => ["off", "0", "false", "no"].includes((value ?? "").trim().toLowerCase());

/** Whether a Gateway call can be signed at all: a key, or Vercel's own identity. */
export function gatewayReachable(env: Env = process.env): boolean {
  return (
    (env.AI_GATEWAY_API_KEY ?? "").trim() !== "" ||
    (env.VERCEL_OIDC_TOKEN ?? "").trim() !== "" ||
    env.VERCEL === "1"
  );
}

/**
 * Whether to ask Jev anything. Off when asked to be off, and off on its own
 * wherever the Gateway cannot be reached — a standalone server on Ollama keeps
 * working, it simply never gets a second opinion.
 */
export function jevEnabled(env: Env = process.env): boolean {
  if (off(env.BOT_JEV)) return false;
  return gatewayReachable(env);
}

export function confidenceFloor(env: Env = process.env): number {
  const raw = Number(env.BOT_JEV_CONFIDENCE);
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : DEFAULT_CONFIDENCE;
}

/** A yes/no answer that is allowed to be neither. */
export type Verdict = "yes" | "no" | "unknown";

/**
 * Reads one boolean answer.
 *
 * Confidence says how concentrated the distribution is, not whether the answer
 * is true. An answer the model is not concentrated about is `unknown`, which
 * every caller treats as "carry on as before" rather than as "no".
 */
export function verdictOf(
  probability: number | undefined,
  confidence: number | undefined,
  floor: number = DEFAULT_CONFIDENCE,
): Verdict {
  if (probability === undefined || !Number.isFinite(probability)) return "unknown";
  if (confidence !== undefined && confidence < floor) return "unknown";
  if (probability >= 0.5 + (1 - floor) / 2) return "yes";
  if (probability <= 0.5 - (1 - floor) / 2) return "no";
  return "unknown";
}

export interface Judgement<QUESTIONS extends Record<string, EvaluationQuestion>> {
  readonly answers: Awaited<ReturnType<typeof evaluate<QUESTIONS>>>["answers"];
  /** How concentrated each answer is, by question id, when the provider reports it. */
  readonly confidence: Readonly<Record<string, number>>;
  readonly inputTokens: number | undefined;
}

function confidenceFrom(metadata: unknown): Record<string, number> {
  const typesafe = (metadata as { typesafe?: { confidence?: unknown } } | undefined)?.typesafe?.confidence;
  if (typeof typesafe !== "object" || typesafe === null) return {};
  const out: Record<string, number> = {};
  for (const [id, value] of Object.entries(typesafe as Record<string, unknown>)) {
    if (typeof value === "number" && Number.isFinite(value)) out[id] = value;
  }
  return out;
}

/**
 * Asks Jev, and never throws.
 *
 * Every failure — off, no Gateway, a slow answer, a provider error — is the
 * same null, because every caller has to handle that case anyway and none of
 * them should care why.
 */
export async function judge<const QUESTIONS extends Record<string, EvaluationQuestion>>(
  state: unknown,
  questions: QUESTIONS,
  options: { readonly timeoutMs?: number; readonly abortSignal?: AbortSignal } = {},
): Promise<Judgement<QUESTIONS> | null> {
  if (!jevEnabled()) return null;
  try {
    const result = await evaluate({
      model: process.env.BOT_JEV_MODEL?.trim() || DEFAULT_MODEL,
      state: state as never,
      questions,
      maxRetries: 0,
      abortSignal: options.abortSignal ?? AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    return {
      answers: result.answers,
      confidence: confidenceFrom(result.providerMetadata),
      inputTokens: result.usage.inputTokens,
    };
  } catch (error) {
    // A judgement nobody is waiting on is not worth a failed job or a loud log.
    if (process.env.BOT_JEV_DEBUG === "1") {
      console.warn(`[bot] Jev did not answer: ${error instanceof Error ? error.message : String(error)}`);
    }
    return null;
  }
}
