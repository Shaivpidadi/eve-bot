import { experimental_decide as decide, type Experimental_DecisionQuestion as EvaluationQuestion } from "ai";

import { chargeUsage, reportedCost } from "./spend";
import type { Usage } from "./usage";
import { chatDecisionModel } from "./endpoint-decisions";
import { customEndpoint, endpointModel, modelForEffort, withGatewayOptions } from "./models";
import { liveEnv } from "./settings/store";

/**
 * Jev: small decisions, for a tenth of a cent.
 *
 * Some of the things a Bot system needs to know are not writing tasks at all.
 * Is this page a sign-in wall? Is this run going in circles? Does this result
 * actually meet the brief? A language model can answer those, slowly and for
 * real money; a decision model answers them as a typed choice, a score, or a
 * probability, and charges for the input alone.
 *
 * It runs on AI Gateway; on your own provider (`BOT_MODEL_BASE_URL`), a chat
 * model there answers the same questions in its place (`endpoint-decisions.ts`),
 * without Jev's calibrated probabilities. Either way every use of this module
 * is optional by construction: `judge` returns null when
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
export function jevEnabled(env: Env = liveEnv()): boolean {
  if (off(env.BOT_JEV)) return false;
  // On your own provider, its chat model answers Jev's questions (see endpoint-decisions.ts).
  if (customEndpoint() !== null) return true;
  return gatewayReachable(env);
}

/** What answers: Jev on AI Gateway, or a chat model on your own provider standing in for it. */
function decisionModel(): { readonly model: Parameters<typeof decide>[0]["model"]; readonly id: string } {
  const endpoint = customEndpoint();
  if (endpoint === null) {
    const id = liveEnv().BOT_JEV_MODEL?.trim() || DEFAULT_MODEL;
    return { model: id, id };
  }
  const id = liveEnv().BOT_JEV_MODEL?.trim() || modelForEffort("quick");
  return { model: chatDecisionModel(endpointModel(endpoint, id), id), id };
}

export function confidenceFloor(env: Env = liveEnv()): number {
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
  readonly answers: Awaited<ReturnType<typeof decide<QUESTIONS>>>["answers"];
  /** How concentrated each answer is, by question id, when the provider reports it. */
  readonly confidence: Readonly<Record<string, number>>;
  readonly inputTokens: number | undefined;
}

const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/**
 * One judgement's usage as the ledger counts it, with Gateway's price when it
 * sent one. The ledger has no "unknown": a price that is missing or not a
 * number is 0 here, while the budget is told separately that nobody priced the
 * call (`reportedCost` is null; see `judge`).
 */
export function spent(usage: unknown, metadata: unknown, model: string = liveEnv().BOT_JEV_MODEL?.trim() || DEFAULT_MODEL): Usage {
  const raw = (usage ?? {}) as { inputTokens?: unknown; outputTokens?: unknown; inputTokenDetails?: { cacheReadTokens?: unknown; cacheWriteTokens?: unknown } };
  return {
    inputTokens: count(raw.inputTokens),
    outputTokens: count(raw.outputTokens),
    cacheReadTokens: count(raw.inputTokenDetails?.cacheReadTokens),
    cacheWriteTokens: count(raw.inputTokenDetails?.cacheWriteTokens),
    costUsd: reportedCost(metadata) ?? 0,
    steps: 1,
    models: { [model]: 1 },
  };
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
  options: {
    readonly timeoutMs?: number;
    readonly abortSignal?: AbortSignal;
    readonly workspaceId?: string;
    /** The run the judgement is for, so its cost draws on that run's budget reservation. */
    readonly runToken?: string;
  } = {},
): Promise<Judgement<QUESTIONS> | null> {
  if (!jevEnabled()) return null;
  try {
    const { model, id } = decisionModel();
    const result = await decide({
      model,
      state: state as never,
      questions,
      ...(customEndpoint() === null ? { providerOptions: withGatewayOptions() } : {}),
      maxRetries: 0,
      abortSignal: options.abortSignal ?? AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    if (options.workspaceId !== undefined) {
      // Jev is a Gateway call like any other; the usage page and the budget should see it. Never in the way of the answer.
      void chargeUsage(options.workspaceId, "jev", spent(result.usage, result.providerMetadata, id), {
        runToken: options.runToken ?? null,
        costReported: reportedCost(result.providerMetadata) !== null,
      }).catch(() => undefined);
    }
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
