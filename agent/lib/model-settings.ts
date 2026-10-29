import { type Catalog, type CatalogModel, FREE_FALLBACK, freeDefault, gatewayCatalog } from "./gateway-models";
import { contextToSend, customEndpoint, defaultModelFor, effortRole, isModelRole, type JobEffort, levelOf, MODEL_ROLES, type ModelRole, nextEffort } from "./models";
import { effectiveEnv, liveEnv } from "./settings/store";

/**
 * Which AI Gateway model each role runs on, chosen in the console's Models page.
 *
 * A setting saved here wins over the deployment's environment variables, which
 * stay the defaults (see `defaultModelFor`). Each chosen model is stored with
 * what Gateway's list said about it when it was saved, so resolving a model on
 * a turn never waits on the list. "Free models only" puts every role on a free
 * model: a role set to a free model keeps it; any other gets the free default,
 * also picked at save time.
 *
 * With a custom endpoint (`BOT_MODEL_BASE_URL`) none of this applies: the
 * endpoint's models come from its environment variables only.
 */
export interface ChosenModel {
  readonly id: string;
  /** In Gateway's list when it was saved; an unlisted id is allowed (the list can lag). */
  readonly listed: boolean;
  readonly free: boolean;
  readonly context: number | null;
  /** Null where it is not known (an unlisted id). */
  readonly vision: boolean | null;
  readonly structured: boolean | null;
  readonly reasoning: boolean | null;
  readonly zdr: "all" | "some" | "none" | null;
}

export interface ModelSettings {
  readonly freeOnly: boolean;
  readonly roles: Readonly<Partial<Record<ModelRole, ChosenModel>>>;
  /** The free model every other role runs on while `freeOnly` is on. */
  readonly freeDefault: ChosenModel | null;
  readonly at: string | null;
  readonly by: string | null;
  /**
   * Your own provider's address these choices were made for; absent or null
   * for AI Gateway. Choices apply only where they were made: a Gateway model
   * name means nothing to Ollama, and the other way round.
   */
  readonly endpoint?: string | null;
}

/** The provider models are chosen among here: your own one's address, or null for AI Gateway. */
const providerHere = (): string | null => customEndpoint()?.baseURL ?? null;

/** The workspace's choices for the provider in use now, or none when they were made for another. */
function forHere(settings: ModelSettings): ModelSettings {
  if ((settings.endpoint ?? null) !== providerHere()) return EMPTY;
  return providerHere() === null ? settings : { ...settings, freeOnly: false };
}

export interface ResolvedModel {
  readonly id: string;
  /** Known context window, for a model eve cannot look up in Gateway's catalog. */
  readonly context: number | null;
  /** Whether the model reasons; null when not known. */
  readonly reasoning: boolean | null;
  readonly free: boolean;
  readonly source: "setting" | "free" | "default";
}

const EMPTY: ModelSettings = { freeOnly: false, roles: {}, freeDefault: null, at: null, by: null };
const CACHE_MS = 30_000;
const key = (workspaceId: string) => `models/${workspaceId}.json`;

/** Gateway model ids: `provider/model`, a safe charset, and a sane length. */
const MODEL_ID = /^[a-z0-9][a-z0-9._-]{0,40}\/[a-z0-9][a-z0-9._:-]{0,79}$/i;
export const isModelId = (value: string): boolean => value.length <= 120 && MODEL_ID.test(value);

/** A model id as your own provider names it (qwen3:8b, mistral-small-3.2, org/model): one word, no spaces. */
const isEndpointModelId = (value: string): boolean => value.length <= 120 && /^[\w./:@+-]+$/.test(value);

const ENDPOINT_CACHE_MS = 60_000;
let endpointList: { readonly catalog: Catalog; readonly until: number; readonly baseURL: string } | null = null;

/**
 * The models your own provider serves, from its `/models` list, in the shape of
 * Gateway's (no prices or capabilities: the list says only their names, so a
 * model is taken to see screenshots and answer in a fixed format until a job
 * shows otherwise, except on Ollama, which says what each model can do).
 * Read for the page and when settings are saved.
 */
export async function endpointCatalog(): Promise<Catalog> {
  const endpoint = customEndpoint();
  if (endpoint === null) return { models: [], at: null, error: null };
  if (endpointList !== null && endpointList.baseURL === endpoint.baseURL && endpointList.until > Date.now()) return endpointList.catalog;
  let catalog: Catalog;
  try {
    const { endpointKey } = await import("./models");
    const key = await endpointKey();
    const response = await fetch(`${endpoint.baseURL}/models`, { headers: key === undefined ? {} : { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Your provider answered ${response.status}.`);
    const body = (await response.json()) as { data?: readonly { id?: unknown }[] };
    const host = new URL(endpoint.baseURL).host;
    const ids = (body.data ?? []).map((entry) => entry.id).filter((id): id is string => typeof id === "string" && isEndpointModelId(id));
    const abilities = await ollamaCapabilities(endpoint.baseURL, ids);
    const models = ids.map((id): CatalogModel => {
      const known = abilities.get(id);
      return { id, name: id, provider: host, free: false, inputPerM: null, priceVaries: false, outputPerM: null, context: endpoint.contextWindowTokens, vision: known === undefined ? true : known.includes("vision"), structured: true, reasoning: known?.includes("thinking") ?? false, zdr: "none" };
    });
    catalog = { models, at: new Date().toISOString(), error: null };
  } catch (error) {
    catalog = { models: [], at: null, error: error instanceof Error ? error.message : "Your provider did not answer." };
  }
  endpointList = { catalog, until: Date.now() + ENDPOINT_CACHE_MS, baseURL: endpoint.baseURL };
  return catalog;
}

/**
 * What each model can do, where the provider is Ollama: its own `/api/show`
 * names a model's capabilities ("vision", "tools", "thinking"), which the
 * OpenAI-style list leaves out. Empty for any other provider, whose models
 * keep the assumption above.
 */
async function ollamaCapabilities(baseURL: string, ids: readonly string[]): Promise<Map<string, readonly string[]>> {
  const found = new Map<string, readonly string[]>();
  const root = baseURL.replace(/\/v1\/?$/, "");
  if (root === baseURL || ids.length === 0) return found;
  await Promise.all(
    ids.slice(0, 50).map(async (id) => {
      try {
        const response = await fetch(`${root}/api/show`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: id }), signal: AbortSignal.timeout(5_000) });
        if (!response.ok) return;
        const capabilities = ((await response.json()) as { capabilities?: unknown }).capabilities;
        if (Array.isArray(capabilities)) found.set(id, capabilities.filter((entry): entry is string => typeof entry === "string"));
      } catch {
        // Not Ollama, or it did not answer: this model keeps the assumption.
      }
    }),
  );
  return found;
}

const cache = new Map<string, { readonly settings: ModelSettings; readonly until: number }>();

/** The workspace's model settings, cached for 30 seconds (another instance may serve the old ones that long). */
export async function readModelSettings(workspaceId: string): Promise<ModelSettings> {
  const hit = cache.get(workspaceId);
  if (hit !== undefined && hit.until > Date.now()) return hit.settings;
  // Loaded lazily, as `machine.ts` does: this module is reached from workflow code, which may not bundle the store.
  const { readDoc } = await import("./store");
  const stored = (await readDoc<ModelSettings>(key(workspaceId)).catch(() => null))?.value ?? null;
  const settings: ModelSettings = stored === null ? EMPTY : { ...EMPTY, ...stored, roles: stored.roles ?? {} };
  cache.set(workspaceId, { settings, until: Date.now() + CACHE_MS });
  return settings;
}

/** Whether people may change models from the console (`BOT_MODELS_EDITABLE=off` locks it). */
export const modelsEditable = (env: Readonly<Record<string, string | undefined>> = process.env): boolean =>
  !/^(0|false|off|no)$/i.test(env.BOT_MODELS_EDITABLE?.trim() ?? "");

const zdrAsked = (env: Readonly<Record<string, string | undefined>>) => /^(1|true|on|yes)$/i.test(env.BOT_ZDR?.trim() ?? "");

function chosen(id: string, entry: CatalogModel | undefined): ChosenModel {
  if (entry === undefined) return { id, listed: false, free: false, context: null, vision: null, structured: null, reasoning: null, zdr: null };
  return { id, listed: true, free: entry.free, context: entry.context, vision: entry.vision, structured: entry.structured, reasoning: entry.reasoning, zdr: entry.zdr };
}

export interface ModelSettingsInput {
  readonly freeOnly?: boolean;
  /** A model id for a role, or null to go back to the deployment's default. */
  readonly roles?: Readonly<Partial<Record<ModelRole, string | null>>>;
}

/**
 * Saves the workspace's model settings, checked against Gateway's list. Refuses
 * a paid or unlisted model while "Free models only" is on, and a model without
 * Zero Data Retention while the deployment asks for it (`BOT_ZDR`), since
 * Gateway would refuse every call to it.
 */
export async function saveModelSettings(
  workspaceId: string,
  input: ModelSettingsInput,
  by: string,
  catalog: Pick<Catalog, "models">,
  env: Readonly<Record<string, string | undefined>> = liveEnv(),
): Promise<{ ok: true; settings: ModelSettings } | { ok: false; error: string }> {
  if (!modelsEditable(env)) return { ok: false, error: "Models are set by this deployment and cannot be changed here." };
  const current = forHere(await readModelSettings(workspaceId));
  const onEndpoint = customEndpoint() !== null;
  // "Free models only" is a choice among AI Gateway's models; your own provider's prices are yours.
  if (onEndpoint && input.freeOnly === true) return { ok: false, error: '"Free models only" chooses among AI Gateway\'s models; on your own provider, pick the models you want.' };
  const freeOnly = onEndpoint ? false : (input.freeOnly ?? current.freeOnly);
  if (freeOnly && zdrAsked(env)) return { ok: false, error: "This deployment asks for Zero Data Retention (BOT_ZDR), and no free model offers it." };
  const byId = new Map(catalog.models.map((model) => [model.id, model]));
  const roles: Partial<Record<ModelRole, ChosenModel>> = { ...current.roles };
  for (const role of MODEL_ROLES) {
    if (input.roles === undefined || !(role in input.roles)) continue;
    const value = input.roles[role];
    if (value === null || value === undefined || value.trim() === "") {
      delete roles[role];
      continue;
    }
    const id = value.trim();
    if (onEndpoint ? !isEndpointModelId(id) : !isModelId(id)) {
      return { ok: false, error: onEndpoint ? `"${id.slice(0, 60)}" is not a model id your provider could serve.` : `"${id.slice(0, 60)}" is not a model id. They look like provider/model, such as anthropic/claude-sonnet-5.` };
    }
    roles[role] = chosen(id, byId.get(id));
  }
  for (const [role, model] of Object.entries(roles) as [ModelRole, ChosenModel][]) {
    if (freeOnly && !model.free) {
      return { ok: false, error: model.listed ? `${model.id} is not free on AI Gateway. Turn off "Free models only" to use it.` : `${model.id} is not in AI Gateway's list, so it can't be checked as free.` };
    }
    if (zdrAsked(env) && model.zdr === "none") return { ok: false, error: `${model.id} offers no Zero Data Retention, which this deployment asks for (BOT_ZDR). Gateway would refuse every call to it (${role}).` };
  }
  const freePick = freeOnly ? freeDefault(catalog) : null;
  const settings: ModelSettings = {
    freeOnly,
    roles,
    freeDefault: freePick === null ? null : chosen(freePick, byId.get(freePick)),
    at: new Date().toISOString(),
    by,
    endpoint: providerHere(),
  };
  const { writeDoc } = await import("./store");
  await writeDoc(key(workspaceId), settings);
  cache.delete(workspaceId);
  return { ok: true, settings };
}

/** The model a role runs on for this workspace: its setting, else the free default under "free only", else the deployment's default. */
export async function resolveModel(workspaceId: string, role: ModelRole): Promise<ResolvedModel> {
  const fallback: ResolvedModel = { id: defaultModelFor(role), context: null, reasoning: null, free: false, source: "default" };
  const settings = await readModelSettings(workspaceId).catch(() => EMPTY);
  // Only choices made for this provider apply; "free only" is AI Gateway's.
  return resolveFrom(forHere(settings), role, fallback);
}

/** `resolveModel` given the settings; for the page, which shows what each role resolves to. */
export function resolveFrom(settings: ModelSettings, role: ModelRole, fallback: ResolvedModel = { id: defaultModelFor(role), context: null, reasoning: null, free: false, source: "default" }): ResolvedModel {
  const set = settings.roles[role];
  const as = (model: ChosenModel, source: ResolvedModel["source"]): ResolvedModel => ({ id: model.id, context: model.context, reasoning: model.reasoning, free: model.free, source });
  if (settings.freeOnly) {
    if (set !== undefined && set.free) return as(set, "setting");
    const free = settings.freeDefault ?? chosen(FREE_FALLBACK, undefined);
    return { ...as(free, "free"), free: true };
  }
  return set === undefined ? fallback : as(set, "setting");
}

const BOT_ROLES: readonly ModelRole[] = ["standard", "quick", "deep"];

/** What will go wrong with a role's model, in plain words, from what Gateway's list says about it now. */
export function roleWarnings(role: ModelRole, settings: ModelSettings, resolved: ResolvedModel, catalog: Pick<Catalog, "models" | "error">, env: Readonly<Record<string, string | undefined>> = process.env): string[] {
  const entry = catalog.models.find((model) => model.id === resolved.id);
  const set = settings.roles[role];
  const warnings: string[] = [];
  if (entry === undefined && catalog.error === null && catalog.models.length > 0) {
    warnings.push(set !== undefined && set.listed ? "AI Gateway no longer lists this model; calls to it may fail." : "This model is not in AI Gateway's list; check the name.");
  }
  if (entry !== undefined && BOT_ROLES.includes(role) && !entry.vision) warnings.push("This model can't see screenshots, so browser steps will fail.");
  if (entry !== undefined && role === "helper" && !entry.structured) warnings.push("This model can't answer in a fixed format, so memories may not be saved.");
  if (entry !== undefined && zdrAsked(env) && entry.zdr === "none") warnings.push("This model offers no Zero Data Retention, which this deployment asks for; Gateway will refuse it.");
  return warnings;
}

export interface ModelsReport {
  readonly editable: boolean;
  /** A custom endpoint's address (host only) when one is set; the models are then its own. */
  readonly endpoint: string | null;
  readonly zdr: boolean;
  readonly freeOnly: boolean;
  readonly freeDefault: ChosenModel | null;
  readonly at: string | null;
  readonly by: string | null;
  readonly catalog: Catalog;
  readonly roles: readonly {
    readonly role: ModelRole;
    readonly setting: ChosenModel | null;
    readonly default: string;
    readonly resolved: ResolvedModel;
    readonly warnings: readonly string[];
  }[];
}

/** Everything the Models page shows for a workspace. */
export async function modelsReport(workspaceId: string, env: Readonly<Record<string, string | undefined>> = liveEnv()): Promise<ModelsReport> {
  const endpoint = customEndpoint();
  const settings = forHere(await readModelSettings(workspaceId));
  const catalog: Catalog = endpoint === null ? await gatewayCatalog() : await endpointCatalog();
  return {
    editable: modelsEditable(env),
    endpoint: endpoint === null ? null : new URL(endpoint.baseURL).host,
    zdr: zdrAsked(env),
    freeOnly: settings.freeOnly,
    freeDefault: settings.freeDefault,
    at: settings.at,
    by: settings.by,
    catalog,
    roles: MODEL_ROLES.map((role) => {
      const resolved = resolveFrom(settings, role);
      const unlisted = catalog.error === null && catalog.models.length > 0 && !catalog.models.some((model) => model.id === resolved.id);
      return {
        role,
        setting: settings.roles[role] ?? null,
        default: defaultModelFor(role),
        resolved,
        warnings: endpoint === null ? roleWarnings(role, settings, resolved, catalog, env) : unlisted ? ["Your provider does not list this model; check the name."] : [],
      };
    }),
  };
}

/** A request body as `saveModelSettings` takes it; null when it is not one. */
export function settingsInput(body: unknown): ModelSettingsInput | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  const input: { freeOnly?: boolean; roles?: Partial<Record<ModelRole, string | null>> } = {};
  if (record.freeOnly !== undefined) {
    if (typeof record.freeOnly !== "boolean") return null;
    input.freeOnly = record.freeOnly;
  }
  if (record.roles !== undefined) {
    if (typeof record.roles !== "object" || record.roles === null || Array.isArray(record.roles)) return null;
    const roles: Partial<Record<ModelRole, string | null>> = {};
    for (const [role, value] of Object.entries(record.roles as Record<string, unknown>)) {
      if (!isModelRole(role) || (value !== null && typeof value !== "string")) return null;
      roles[role] = value;
    }
    input.roles = roles;
  }
  return input;
}

/**
 * The model a job's run on this effort starts on, as `run_job` writes it into
 * the brief: null on a custom endpoint, whose model the teammate picks from
 * the brief's effort as before.
 */
export async function runModel(
  workspaceId: string,
  effort: JobEffort,
): Promise<{ id: string; context: number | null; reasoning: boolean | null; level: ReturnType<typeof levelOf>; free: boolean } | null> {
  const [resolved, env] = await Promise.all([resolveModel(workspaceId, effortRole(effort)).catch(() => null), effectiveEnv(workspaceId).catch(() => process.env)]);
  if (resolved === null) return null;
  // On your own provider only a model chosen in the console is named; the rest pick by effort as before (no reasoning level: many local servers reject one).
  if (customEndpoint() !== null) return resolved.source === "setting" ? { id: resolved.id, context: null, reasoning: null, level: null, free: false } : null;
  // How hard a Bot reasons, from Settings; written into the brief with the model, so the run keeps both.
  const level = levelOf(env.BOT_TEAMMATE_REASONING);
  if (resolved.source === "default") return { id: resolved.id, context: null, reasoning: null, level, free: false };
  return { id: resolved.id, context: contextToSend(resolved.context), reasoning: resolved.reasoning, level, free: resolved.free };
}

/** Whether the next effort up would run on the model this one already does (a retry would gain nothing). */
export async function sameModelNext(workspaceId: string, effort: JobEffort): Promise<boolean> {
  const [now, next] = await Promise.all([runModel(workspaceId, effort), runModel(workspaceId, nextEffort(effort))]);
  return now !== null && next !== null && now.id === next.id;
}

/** For tests. */
export function forgetModelSettings(): void {
  cache.clear();
}
