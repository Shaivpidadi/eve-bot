import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

import { pricedModel } from "./pricing";
import { steadyModel } from "./steady";

/**
 * Which model does a job.
 *
 * HQ rates each job's effort when it assigns it, and the teammate running the
 * job picks its model from that rating. Most work does not need the most
 * capable model, and browser work is expensive on one: every step re-sends the
 * page. A job that fails is re-run one level up (see `run_job`).
 *
 * The defaults are models the AI Gateway catalog lists as neither retaining nor
 * training on data, since Bots read inboxes and documents. Override a level
 * with `BOT_MODEL_QUICK`, `BOT_MODEL_STANDARD`, or `BOT_MODEL_DEEP`;
 * `BOT_TEAMMATE_MODEL` pins one model for every level.
 */
export const JOB_EFFORTS = ["quick", "standard", "deep"] as const;
export type JobEffort = (typeof JOB_EFFORTS)[number];

export const DEFAULT_EFFORT: JobEffort = "standard";

const DEFAULT_MODELS: Readonly<Record<JobEffort, string>> = {
  // $0.16 / $0.47 per million tokens: lookups, status checks, routine monitors.
  quick: "alibaba/qwen3.8-flash",
  // $2 / $10: most work, from browsing apps to reading and drafting.
  standard: "anthropic/claude-sonnet-5",
  // $5 / $25: hard multi-step research, analysis, coding, anything high-stakes.
  deep: "anthropic/claude-opus-5",
};

/**
 * What each level is for, in words HQ reads when it rates a job
 * when it rates one instead (see `tools/assign_job.ts`).
 */
export const EFFORT_DESCRIPTIONS: Readonly<Record<JobEffort, string>> = {
  quick:
    "Lookups, status checks, and simple routine monitors: one page or one query, a short answer, nothing to judge. The cheapest model, about a tenth of standard.",
  standard:
    "Most work: operating a web app, reading and summarising, drafting, following a clear multi-step brief. The default.",
  deep: "Hard multi-step research or analysis, coding, ambiguous instructions, or anything high-stakes where a mistake is costly. The most capable model, about 2.5 times standard.",
};

const MODEL_ENV: Readonly<Record<JobEffort, string>> = {
  quick: "BOT_MODEL_QUICK",
  standard: "BOT_MODEL_STANDARD",
  deep: "BOT_MODEL_DEEP",
};

export const isJobEffort = (value: unknown): value is JobEffort =>
  typeof value === "string" && (JOB_EFFORTS as readonly string[]).includes(value);

export function modelForEffort(effort: JobEffort): string {
  const pinned = process.env.BOT_TEAMMATE_MODEL?.trim();
  if (pinned) return pinned;
  const level = process.env[MODEL_ENV[effort]]?.trim();
  if (level) return level;
  return customEndpoint() === null ? DEFAULT_MODELS[effort] : endpointDefaultModel();
}

/** One level up, for a job whose last run failed. */
export function nextEffort(effort: JobEffort): JobEffort {
  return effort === "quick" ? "standard" : "deep";
}

const EFFORT_LINE = /^effort: (quick|standard|deep)$/m;

/** The brief states the job's effort on its own line (see `renderBrief`). */
export function effortInBrief(brief: string): JobEffort {
  const match = EFFORT_LINE.exec(brief)?.[1];
  return isJobEffort(match) ? match : DEFAULT_EFFORT;
}

export const REASONING_LEVELS = ["low", "medium", "high", "xhigh"] as const;
export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

export function reasoningLevel(value: string | undefined, fallback: ReasoningLevel): ReasoningLevel {
  return REASONING_LEVELS.find((level) => level === value) ?? fallback;
}

// ---------------------------------------------------------------------------
// Your own model endpoint
// ---------------------------------------------------------------------------

export interface ModelEndpoint {
  readonly baseURL: string;
  readonly apiKey: string | undefined;
  readonly contextWindowTokens: number;
}

const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;

/**
 * An API that speaks OpenAI's chat completions format: Ollama, LM Studio, vLLM,
 * OpenRouter, or a company proxy. Setting `BOT_MODEL_BASE_URL` (for example
 * `http://localhost:11434/v1`) sends every model name to it instead of Vercel
 * AI Gateway. `BOT_MODEL` names the model used everywhere unless
 * `BOT_HQ_MODEL`, `BOT_TEAMMATE_MODEL`, or a `BOT_MODEL_*` level overrides it.
 * Such models are not in the Gateway's catalog, so their context window comes
 * from `BOT_MODEL_CONTEXT_TOKENS`, and the USD spend caps cannot price them.
 */
export function customEndpoint(): ModelEndpoint | null {
  const baseURL = process.env.BOT_MODEL_BASE_URL?.trim();
  if (!baseURL) return null;
  const tokens = Number(process.env.BOT_MODEL_CONTEXT_TOKENS);
  return {
    baseURL: baseURL.replace(/\/+$/, ""),
    apiKey: process.env.BOT_MODEL_API_KEY?.trim() || undefined,
    contextWindowTokens: Number.isSafeInteger(tokens) && tokens > 0 ? tokens : DEFAULT_CONTEXT_WINDOW_TOKENS,
  };
}

function endpointDefaultModel(): string {
  const model = process.env.BOT_MODEL?.trim();
  if (model) return model;
  throw new Error(
    "BOT_MODEL_BASE_URL is set, so set BOT_MODEL to a model that endpoint serves (for example qwen3:8b), or unset BOT_MODEL_BASE_URL to use Vercel AI Gateway.",
  );
}

let endpointProvider: { readonly baseURL: string; readonly provider: ReturnType<typeof createOpenAICompatible> } | null = null;

/**
 * A model on the custom endpoint, as the AI SDK model object eve calls directly,
 * with every step priced from `BOT_MODEL_PRICES` or OpenRouter's list so the USD
 * caps hold (see `pricing.ts`), and a stream the endpoint drops early ended
 * cleanly rather than failing the turn (see `steady.ts`).
 */
export function endpointModel(endpoint: ModelEndpoint, id: string): LanguageModel {
  if (endpointProvider?.baseURL !== endpoint.baseURL) {
    endpointProvider = {
      baseURL: endpoint.baseURL,
      provider: createOpenAICompatible({
        name: "custom",
        baseURL: endpoint.baseURL,
        // Streams carry no token counts unless asked; pricing and the caps need them.
        includeUsage: true,
        ...(endpoint.apiKey === undefined ? {} : { apiKey: endpoint.apiKey }),
      }),
    };
  }
  // Nearest the wire: a stream the endpoint drops early still ends in a finish the pricing layer can read.
  return pricedModel(steadyModel(endpointProvider.provider.chatModel(id)), endpoint.baseURL, id);
}

// ---------------------------------------------------------------------------
// Spend
// ---------------------------------------------------------------------------

/**
 * Token caps for a session on a custom endpoint, the backstop for a model
 * nothing prices. A runaway loop on a free local model costs electricity, not
 * dollars, but it still ties up the team's computer; these stop it. On AI
 * Gateway the USD caps do that job and eve's own defaults apply.
 */
const TOKEN_LIMITS = {
  hq: { input: ["BOT_HQ_INPUT_TOKEN_LIMIT", 40_000_000], output: ["BOT_HQ_OUTPUT_TOKEN_LIMIT", 2_000_000] },
  job: { input: ["BOT_JOB_INPUT_TOKEN_LIMIT", 10_000_000], output: ["BOT_JOB_OUTPUT_TOKEN_LIMIT", 500_000] },
} as const satisfies Record<string, Record<"input" | "output", readonly [string, number]>>;

function tokenLimit([name, fallback]: readonly [string, number]): number | false {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") return fallback;
  if (/^(0|off|false|none)$/i.test(value)) return false;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function tokenLimits(role: keyof typeof TOKEN_LIMITS): {
  readonly maxInputTokensPerSession?: number | false;
  readonly maxOutputTokensPerSession?: number | false;
} {
  if (customEndpoint() === null) return {};
  return {
    maxInputTokensPerSession: tokenLimit(TOKEN_LIMITS[role].input),
    maxOutputTokensPerSession: tokenLimit(TOKEN_LIMITS[role].output),
  };
}

/** HQ's model: a Gateway model name, or a model on the custom endpoint with its context window. */
export function hqModel():
  | { readonly model: string }
  | { readonly model: LanguageModel; readonly modelContextWindowTokens: number } {
  const endpoint = customEndpoint();
  const named = process.env.BOT_HQ_MODEL?.trim();
  if (endpoint === null) return { model: named || "anthropic/claude-sonnet-5" };
  return { model: endpointModel(endpoint, named || endpointDefaultModel()), modelContextWindowTokens: endpoint.contextWindowTokens };
}

/**
 * Reasoning effort for an agent. Gateway models get the level (or the default);
 * a custom endpoint gets one only when it is set explicitly, since many local
 * servers reject reasoning parameters they do not support.
 */
export function reasoningFor(
  value: string | undefined,
  fallback: ReasoningLevel,
): { readonly reasoning?: ReasoningLevel } {
  if (customEndpoint() !== null && value === undefined) return {};
  return { reasoning: reasoningLevel(value, fallback) };
}
