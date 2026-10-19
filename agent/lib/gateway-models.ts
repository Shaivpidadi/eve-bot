/**
 * The models Vercel AI Gateway serves, from its public list, for the console's
 * Models page: the language models that can call tools (a Bot needs tools),
 * with what each costs and can do.
 *
 * The list is public (no key) and changes week to week: free models come and
 * go, stealth ones vanish. So it is read for the page and when settings are
 * saved, never on a turn's path; a failed read keeps the last good list.
 */
export interface CatalogModel {
  readonly id: string;
  readonly name: string;
  /** Who makes it, from the id's prefix (`anthropic/…`). */
  readonly provider: string;
  /** Costs nothing in and out, at every provider. */
  readonly free: boolean;
  /** USD per million tokens, or null where Gateway gives no flat price. */
  readonly inputPerM: number | null;
  /** The price depends on which provider serves the call, so the figures are only a floor. */
  readonly priceVaries: boolean;
  readonly outputPerM: number | null;
  readonly context: number | null;
  /** The most it writes in one call, as Gateway lists it. */
  readonly maxOutput?: number | null;
  /** Takes images, which the browser needs (it works from screenshots). */
  readonly vision: boolean;
  /** Answers in a JSON schema, which memory extraction needs. */
  readonly structured: boolean;
  readonly reasoning: boolean;
  /** Zero Data Retention: offered by every provider, some, or none. */
  readonly zdr: "all" | "some" | "none";
}

export interface Catalog {
  readonly models: readonly CatalogModel[];
  readonly at: string | null;
  /** Why the list could not be read, when it could not. */
  readonly error: string | null;
}

/** The free model to fall back on when the list cannot be read: tools, screenshots and memory all work on it (checked 19 Oct 2026). */
export const FREE_FALLBACK = "minimax/minimax-m3.1-flash";

const MODELS_URL = "https://ai-gateway.vercel.sh/v1/models";
const CACHE_MS = 10 * 60_000;

let cached: { readonly catalog: Catalog; readonly until: number } | undefined;
let lastGood: Catalog | undefined;

const perMillion = (value: unknown): number | null => {
  const parsed = typeof value === "string" || typeof value === "number" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed * 1e6 * 1e6) / 1e6 : null;
};

const record = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {});

/** One entry of Gateway's list, or null for anything a Bot cannot run on. */
export function toCatalogModel(raw: unknown): CatalogModel | null {
  const entry = record(raw);
  const id = typeof entry.id === "string" ? entry.id : "";
  if (entry.type !== "language" || !/^[\w.-]+\/[\w.:-]+$/.test(id)) return null;
  const tags = Array.isArray(entry.tags) ? entry.tags.filter((tag): tag is string => typeof tag === "string") : [];
  if (!tags.includes("tool-use")) return null;
  // Batch variants answer later through Gateway's batch API, not within a turn; they can still be named outright.
  if (/-batch$/.test(id)) return null;
  const pricing = record(entry.pricing);
  const inputPerM = perMillion(pricing.input);
  const outputPerM = perMillion(pricing.output);
  const inputs = Array.isArray(record(entry.modalities).input) ? (record(entry.modalities).input as unknown[]) : [];
  const zdr = entry.zdr === "all" || entry.zdr === "some" ? entry.zdr : "none";
  return {
    id,
    name: typeof entry.name === "string" && entry.name.trim() !== "" ? entry.name.trim() : id,
    provider: id.split("/")[0]!,
    free: inputPerM === 0 && outputPerM === 0 && pricing.varies_by_provider !== true,
    inputPerM,
    priceVaries: pricing.varies_by_provider === true,
    outputPerM,
    context: typeof entry.context_window === "number" && entry.context_window > 0 ? entry.context_window : null,
    maxOutput: typeof entry.max_tokens === "number" && entry.max_tokens > 0 ? entry.max_tokens : null,
    vision: tags.includes("vision") || inputs.includes("image"),
    structured: tags.includes("structured-output"),
    reasoning: tags.includes("reasoning"),
    zdr,
  };
}

/** Free first, then cheapest first by output price, then by name. */
export function sortCatalog(models: readonly CatalogModel[]): CatalogModel[] {
  const price = (model: CatalogModel) => (model.free ? -1 : (model.outputPerM ?? Number.POSITIVE_INFINITY));
  return [...models].sort((left, right) => price(left) - price(right) || left.name.localeCompare(right.name));
}

/** The free model a team on free models gets by default: one that can see screenshots, else any free one. */
export function freeDefault(catalog: Pick<Catalog, "models">): string {
  const free = catalog.models.filter((model) => model.free);
  const best = free.find((model) => model.vision && model.structured) ?? free.find((model) => model.vision) ?? free[0];
  return best?.id ?? FREE_FALLBACK;
}

/** Gateway's list, cached for ten minutes; the last good list (or an empty one, with the reason) when it cannot be read. */
export async function gatewayCatalog(fetcher: typeof fetch = fetch): Promise<Catalog> {
  if (cached !== undefined && cached.until > Date.now()) return cached.catalog;
  let catalog: Catalog;
  try {
    const response = await fetcher(MODELS_URL, { signal: AbortSignal.timeout(8_000) });
    if (!response.ok) throw new Error(`AI Gateway answered ${response.status}`);
    const body = record(await response.json());
    const data = Array.isArray(body.data) ? body.data : [];
    const models = sortCatalog(data.map(toCatalogModel).filter((model): model is CatalogModel => model !== null));
    if (models.length === 0) throw new Error("AI Gateway listed no models");
    catalog = { models, at: new Date().toISOString(), error: null };
    lastGood = catalog;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    catalog = lastGood === undefined ? { models: [], at: null, error: reason } : { ...lastGood, error: reason };
  }
  // A failure is retried sooner than a success is refreshed.
  cached = { catalog, until: Date.now() + (catalog.error === null ? CACHE_MS : 60_000) };
  return catalog;
}

/** A model as Gateway lists it, or null when it does not (or the list cannot be read). */
export async function listedModel(id: string): Promise<CatalogModel | null> {
  const catalog = await gatewayCatalog().catch(() => null);
  return catalog?.models.find((model) => model.id === id) ?? null;
}

/** For tests. */
export function forgetGatewayCatalog(): void {
  cached = undefined;
  lastGood = undefined;
}
