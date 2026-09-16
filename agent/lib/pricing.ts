import { wrapLanguageModel, type LanguageModel, type LanguageModelMiddleware } from "ai";

// The step shapes, taken from the middleware type so they match the AI SDK `ai` bundles.
type GenerateResult = Awaited<ReturnType<Parameters<NonNullable<LanguageModelMiddleware["wrapGenerate"]>>[0]["doGenerate"]>>;
type StreamResult = Awaited<ReturnType<Parameters<NonNullable<LanguageModelMiddleware["wrapStream"]>>[0]["doStream"]>>;
type StreamPart = StreamResult["stream"] extends ReadableStream<infer Part> ? Part : never;
type Usage = GenerateResult["usage"];
type ProviderMetadata = NonNullable<GenerateResult["providerMetadata"]>;

/**
 * What a model on your own endpoint costs, so the USD spend caps hold there too.
 *
 * eve adds up the cost each model step reports in `providerMetadata.gateway.cost`
 * and stops a session at `maxTokenCostUsdPerSession`. AI Gateway fills that in;
 * an OpenAI-compatible endpoint does not, so without help every step there
 * costs nothing and the caps never trigger. This module prices the step from
 * its token usage and writes the cost where eve reads it.
 *
 * Prices come from `BOT_MODEL_PRICES`, one entry per model as USD per million
 * input and output tokens (`qwen3:8b=0/0,anthropic/claude-sonnet-4.5=3/15`, with
 * `*=in/out` for anything else), and from OpenRouter's public model list when
 * the endpoint is OpenRouter. A model with no price adds nothing, which is
 * right for a model running on your own hardware; the token caps in
 * `models.ts` are the backstop then.
 */

export interface ModelPrice {
  /** USD per million input tokens. */
  readonly input: number;
  /** USD per million output tokens. */
  readonly output: number;
}

const PER_MILLION = 1_000_000;
const OPENROUTER_HOST = /(^|\.)openrouter\.ai$/i;
const OPENROUTER_REFRESH_MS = 60 * 60_000;

/** `model=in/out,model=in/out`, USD per million tokens; `*` is the fallback for every other model. */
export function parsePrices(value: string | undefined): ReadonlyMap<string, ModelPrice> {
  const prices = new Map<string, ModelPrice>();
  for (const entry of (value ?? "").split(",")) {
    const cut = entry.lastIndexOf("=");
    if (cut <= 0) continue;
    const model = entry.slice(0, cut).trim();
    const [input = NaN, output = NaN] = entry
      .slice(cut + 1)
      .split("/")
      .map((part) => Number(part.trim()));
    if (model === "" || !Number.isFinite(input) || input < 0 || !Number.isFinite(output) || output < 0) {
      console.warn(`[bot] BOT_MODEL_PRICES: ignoring "${entry.trim()}"; expected model=input/output in USD per million tokens.`);
      continue;
    }
    prices.set(model, { input, output });
  }
  return prices;
}

let configured: ReadonlyMap<string, ModelPrice> | null = null;

function configuredPrices(): ReadonlyMap<string, ModelPrice> {
  configured ??= parsePrices(process.env.BOT_MODEL_PRICES);
  return configured;
}

// ---------------------------------------------------------------------------
// OpenRouter
// ---------------------------------------------------------------------------

interface OpenRouterCatalog {
  readonly at: number;
  readonly prices: Promise<ReadonlyMap<string, ModelPrice>>;
}

let catalog: OpenRouterCatalog | null = null;

export const isOpenRouter = (baseURL: string): boolean => {
  try {
    return OPENROUTER_HOST.test(new URL(baseURL).hostname);
  } catch {
    return false;
  }
};

/** OpenRouter lists every model with its USD price per token; no key is needed. */
async function fetchOpenRouterPrices(baseURL: string): Promise<ReadonlyMap<string, ModelPrice>> {
  const prices = new Map<string, ModelPrice>();
  try {
    const response = await fetch(`${baseURL}/models`, { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as { data?: ReadonlyArray<{ id?: unknown; pricing?: { prompt?: unknown; completion?: unknown } }> };
    for (const model of body.data ?? []) {
      const input = Number(model.pricing?.prompt);
      const output = Number(model.pricing?.completion);
      if (typeof model.id !== "string" || !Number.isFinite(input) || !Number.isFinite(output)) continue;
      prices.set(model.id, { input: Math.max(0, input) * PER_MILLION, output: Math.max(0, output) * PER_MILLION });
    }
  } catch (error) {
    console.warn(
      `[bot] Could not read OpenRouter's price list (${error instanceof Error ? error.message : String(error)}); set BOT_MODEL_PRICES so the spend caps hold.`,
    );
  }
  return prices;
}

/** The list is read once an hour; every step in between prices from the copy. */
function openRouterPrices(baseURL: string): Promise<ReadonlyMap<string, ModelPrice>> {
  if (catalog === null || Date.now() - catalog.at > OPENROUTER_REFRESH_MS) {
    catalog = { at: Date.now(), prices: fetchOpenRouterPrices(baseURL) };
  }
  return catalog.prices;
}

// ---------------------------------------------------------------------------
// Pricing a step
// ---------------------------------------------------------------------------

/** The price for a model on this endpoint, or null when nothing prices it. */
export async function priceFor(baseURL: string, modelId: string): Promise<ModelPrice | null> {
  const own = configuredPrices();
  const exact = own.get(modelId);
  if (exact !== undefined) return exact;
  if (isOpenRouter(baseURL)) {
    const listed = (await openRouterPrices(baseURL)).get(modelId);
    if (listed !== undefined) return listed;
  }
  return own.get("*") ?? null;
}

export function costOf(usage: Usage, price: ModelPrice): number {
  const input = usage.inputTokens.total ?? 0;
  const output = usage.outputTokens.total ?? 0;
  return (input * price.input + output * price.output) / PER_MILLION;
}

/** Adds the step's cost where eve reads AI Gateway's, next to whatever the provider reported. */
function withCost(metadata: ProviderMetadata | undefined, cost: number): ProviderMetadata {
  return { ...metadata, gateway: { ...metadata?.gateway, cost } };
}

type WrappableModel = Parameters<typeof wrapLanguageModel>[0]["model"];

/** Prices every step of `model` from its token usage, when a price is known. */
export function pricedModel(model: WrappableModel, baseURL: string, modelId: string): LanguageModel {
  const middleware: LanguageModelMiddleware = {
    specificationVersion: "v4",
    async wrapGenerate({ doGenerate }) {
      const [result, price] = await Promise.all([doGenerate(), priceFor(baseURL, modelId)]);
      if (price === null) return result;
      return { ...result, providerMetadata: withCost(result.providerMetadata, costOf(result.usage, price)) };
    },
    async wrapStream({ doStream }) {
      const [result, price] = await Promise.all([doStream(), priceFor(baseURL, modelId)]);
      if (price === null) return result;
      const priced = new TransformStream<StreamPart, StreamPart>({
        transform(part, controller) {
          controller.enqueue(
            part.type === "finish"
              ? { ...part, providerMetadata: withCost(part.providerMetadata, costOf(part.usage, price)) }
              : part,
          );
        },
      });
      return { ...result, stream: result.stream.pipeThrough(priced) };
    },
  };
  return wrapLanguageModel({ model, middleware });
}
