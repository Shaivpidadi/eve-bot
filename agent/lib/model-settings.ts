import { type Catalog, type CatalogModel, FREE_FALLBACK, freeDefault } from "./gateway-models";
import { customEndpoint, defaultModelFor, MODEL_ROLES, type ModelRole } from "./models";
import { readDoc, writeDoc } from "./store";

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

const cache = new Map<string, { readonly settings: ModelSettings; readonly until: number }>();

/** The workspace's model settings, cached for 30 seconds (another instance may serve the old ones that long). */
export async function readModelSettings(workspaceId: string): Promise<ModelSettings> {
  const hit = cache.get(workspaceId);
  if (hit !== undefined && hit.until > Date.now()) return hit.settings;
  const stored = (await readDoc<ModelSettings>(key(workspaceId)).catch(() => null))?.value ?? null;
  const settings: ModelSettings = stored === null ? EMPTY : { ...EMPTY, ...stored, roles: stored.roles ?? {} };
  cache.set(workspaceId, { settings, until: Date.now() + CACHE_MS });
  return settings;
}

/** Whether people may change models from the console (`BOT_MODELS_EDITABLE=off` locks it). */
export const modelsEditable = (env: Readonly<Record<string, string | undefined>> = process.env): boolean =>
  !/^(0|false|off|no)$/i.test(env.BOT_MODELS_EDITABLE?.trim() ?? "") && customEndpoint() === null;

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
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<{ ok: true; settings: ModelSettings } | { ok: false; error: string }> {
  if (!modelsEditable(env)) return { ok: false, error: "Models are set by this deployment and cannot be changed here." };
  const current = await readModelSettings(workspaceId);
  const freeOnly = input.freeOnly ?? current.freeOnly;
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
    if (!isModelId(id)) return { ok: false, error: `"${id.slice(0, 60)}" is not a model id. They look like provider/model, such as anthropic/claude-sonnet-5.` };
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
  };
  await writeDoc(key(workspaceId), settings);
  cache.delete(workspaceId);
  return { ok: true, settings };
}

/** The model a role runs on for this workspace: its setting, else the free default under "free only", else the deployment's default. */
export async function resolveModel(workspaceId: string, role: ModelRole): Promise<ResolvedModel> {
  const fallback: ResolvedModel = { id: defaultModelFor(role), context: null, reasoning: null, free: false, source: "default" };
  if (customEndpoint() !== null) return fallback;
  const settings = await readModelSettings(workspaceId).catch(() => EMPTY);
  return resolveFrom(settings, role, fallback);
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

/** For tests. */
export function forgetModelSettings(): void {
  cache.clear();
}
