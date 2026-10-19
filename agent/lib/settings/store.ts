import { SETTINGS, SETTINGS_BY_ENV, normalizeValue, type SettingDef } from "./registry";

/**
 * Settings saved in the console (see `registry.ts` and `docs/plan/settings-ui.md`).
 *
 * Saved per deployment (`settings/_deployment.json`; no workspace id starts
 * with an underscore) and per workspace (`settings/<ws>/settings.json`, next
 * to the operator's name). Values are the strings the environment variables
 * would hold; secrets are sealed and never sent back. `effectiveEnv` lays them
 * over `process.env`: a saved value wins, the variable is the default.
 *
 * Read with a 30 s cache per process; a save clears this instance's cache, and
 * another instance may serve the old values that long. The store is loaded
 * lazily: some readers sit in modules that workflow bundles reach.
 */
interface SettingsDoc {
  readonly values: Readonly<Record<string, string>>;
  /** Sealed secrets, by variable name. */
  readonly sealed: Readonly<Record<string, string>>;
  readonly at: string | null;
  readonly by: string | null;
}

const EMPTY: SettingsDoc = { values: {}, sealed: {}, at: null, by: null };
const CACHE_MS = 30_000;
const SEAL_LABEL = "bot-settings";
export const DEPLOYMENT_KEY = "settings/_deployment.json";
export const workspaceKey = (workspaceId: string) => `settings/${workspaceId}/settings.json`;

const cache = new Map<string, { readonly doc: SettingsDoc; readonly until: number }>();
let version = 0;

/** Bumped on every save in this process, for caches built from settings (scripts written to the computer, say). */
export const settingsVersion = (): number => version;

async function readSettingsDoc(key: string): Promise<SettingsDoc> {
  const hit = cache.get(key);
  if (hit !== undefined && hit.until > Date.now()) return hit.doc;
  const { readDoc } = await import("../store");
  const stored = (await readDoc<SettingsDoc>(key).catch(() => null))?.value ?? null;
  const doc: SettingsDoc = stored === null ? EMPTY : { values: stored.values ?? {}, sealed: stored.sealed ?? {}, at: stored.at ?? null, by: stored.by ?? null };
  cache.set(key, { doc, until: Date.now() + CACHE_MS });
  return doc;
}

const on = (value: string | undefined) => /^(1|true|on|yes)$/i.test(value?.trim() ?? "");
const amount = (value: string | undefined) => {
  const parsed = Number(value?.trim());
  return value === undefined || value.trim() === "" || /^(0|off|false|none)$/i.test(value.trim()) || !Number.isFinite(parsed) || parsed <= 0 ? null : parsed;
};

/** The spend caps a workspace may only lower: the deployment's (saved or env) is the ceiling. */
const CEILINGS = new Set(["BOT_BUDGET_MONTHLY_USD", "BOT_BUDGET_DAILY_USD"]);

/**
 * The environment with saved settings laid over it, for the deployment and, given
 * one, a workspace. Pass it to readers that take an `env` (budgetLimits,
 * jevEnabled, gatewayOptions, …) so precedence lives in one place.
 */
export async function effectiveEnv(workspaceId?: string, base: Readonly<Record<string, string | undefined>> = process.env): Promise<Record<string, string | undefined>> {
  const [deployment, workspace] = await Promise.all([readSettingsDoc(DEPLOYMENT_KEY), workspaceId === undefined ? Promise.resolve(EMPTY) : readSettingsDoc(workspaceKey(workspaceId))]);
  const env: Record<string, string | undefined> = { ...base };
  const lay = (doc: SettingsDoc, scope: SettingDef["scope"]) => {
    for (const [name, value] of Object.entries(doc.values)) {
      const def = SETTINGS_BY_ENV.get(name);
      if (def === undefined || def.scope !== scope || def.page === "models") continue;
      // The worker is turned on by the deployment's environment; a setting can only pause it.
      if (name === "BOT_WORKER") {
        if (value === "off") env[name] = "off";
        continue;
      }
      if (CEILINGS.has(name) && scope === "workspace") {
        const ceiling = amount(env[name]);
        const asked = amount(value);
        env[name] = ceiling !== null && (asked === null || asked > ceiling) ? env[name] : value;
        continue;
      }
      env[name] = value;
    }
  };
  // Deployment first, then the workspace's own, which wins where it may.
  lay(deployment, "deployment");
  await unsealInto(env, deployment, "deployment");
  lay(workspace, "workspace");
  await unsealInto(env, workspace, "workspace");
  return env;
}

async function unsealInto(env: Record<string, string | undefined>, doc: SettingsDoc, scope: SettingDef["scope"]): Promise<void> {
  const entries = Object.entries(doc.sealed);
  if (entries.length === 0) return;
  const { unsealWith } = await import("../seal");
  for (const [name, sealed] of entries) {
    if (SETTINGS_BY_ENV.get(name)?.scope !== scope) continue;
    const value = await unsealWith(SEAL_LABEL, sealed);
    // A secret that can no longer be opened (an import from elsewhere) reads as not set.
    if (value !== null) env[name] = value;
  }
}

export interface SaveCaller {
  readonly workspaceId: string;
  readonly owner: boolean;
  readonly by: string;
}

/** Whether the console may change settings at all (`BOT_SETTINGS_EDITABLE=off` makes them read-only). */
export const settingsEditable = (env: Readonly<Record<string, string | undefined>> = process.env): boolean =>
  !/^(0|false|off|no)$/i.test(env.BOT_SETTINGS_EDITABLE?.trim() ?? "");

/**
 * Saves changes (a value, or null to go back to the environment's). Deployment
 * settings need the owner; a workspace's budget may only go below the
 * deployment's. All checked before anything is written.
 */
export async function saveSettings(caller: SaveCaller, changes: Readonly<Record<string, unknown>>, base: Readonly<Record<string, string | undefined>> = process.env): Promise<{ ok: true } | { ok: false; status: 400 | 403; error: string }> {
  if (!settingsEditable(base)) return { ok: false, status: 403, error: "Settings are set by this deployment's environment and cannot be changed here." };
  const plan: { def: SettingDef; value: string | null }[] = [];
  for (const [name, raw] of Object.entries(changes)) {
    const def = SETTINGS_BY_ENV.get(name);
    if (def === undefined) return { ok: false, status: 400, error: `${name} is not a setting the console changes.` };
    if (def.page === "models") return { ok: false, status: 400, error: `${def.label} is set on the Models page.` };
    if (def.scope === "deployment" && !caller.owner) return { ok: false, status: 403, error: `${def.label} applies to the whole deployment; only its owner can change it.` };
    if (raw === null) {
      plan.push({ def, value: null });
      continue;
    }
    const normalized = normalizeValue(def, raw);
    if (!normalized.ok) return { ok: false, status: 400, error: normalized.error };
    plan.push({ def, value: normalized.value });
  }
  // A tenant's budget stays under the deployment's ceiling.
  if (!caller.owner) {
    const ceilingEnv = await effectiveEnv(undefined, base);
    for (const { def, value } of plan) {
      if (!CEILINGS.has(def.env) || value === null) continue;
      const ceiling = amount(ceilingEnv[def.env]);
      const asked = amount(value);
      if (ceiling !== null && (asked === null || asked > ceiling)) return { ok: false, status: 403, error: `${def.label} can't be above this deployment's, $${ceiling}.` };
    }
  }
  const { updateDoc } = await import("../store");
  const { sealWith } = await import("../seal");
  const now = new Date().toISOString();
  for (const scope of ["deployment", "workspace"] as const) {
    const mine = plan.filter((entry) => entry.def.scope === scope);
    if (mine.length === 0) continue;
    const sealedNow = new Map<string, string>();
    for (const { def, value } of mine) if (def.kind.type === "secret" && value !== null) sealedNow.set(def.env, await sealWith(SEAL_LABEL, value));
    const key = scope === "deployment" ? DEPLOYMENT_KEY : workspaceKey(caller.workspaceId);
    await updateDoc<SettingsDoc>(key, (current) => {
      const values: Record<string, string> = { ...(current?.values ?? {}) };
      const sealed: Record<string, string> = { ...(current?.sealed ?? {}) };
      for (const { def, value } of mine) {
        const bag = def.kind.type === "secret" ? sealed : values;
        if (value === null) delete bag[def.env];
        else bag[def.env] = def.kind.type === "secret" ? sealedNow.get(def.env)! : value;
      }
      return { values, sealed, at: now, by: caller.by };
    });
    cache.delete(key);
  }
  version += 1;
  return { ok: true };
}

export interface SettingView {
  readonly env: string;
  readonly area: SettingDef["area"];
  readonly label: string;
  readonly help: string;
  readonly scope: SettingDef["scope"];
  readonly tier: SettingDef["tier"];
  readonly kind: SettingDef["kind"];
  readonly fallback: string;
  /** What applies now: the saved value, else the variable's; null for a secret (see `isSet`) or nothing set. */
  readonly value: string | null;
  readonly source: "setting" | "env" | "default";
  /** For a secret: whether one is set, without showing it. */
  readonly isSet: boolean;
  /** A saved value is hiding a variable that is set too. */
  readonly overridesEnv: boolean;
  readonly editable: boolean;
}

/** Every setting this caller may see, as the Settings page shows them. Tenants see only their workspace's. */
export async function settingsReport(
  caller: Pick<SaveCaller, "workspaceId" | "owner">,
  base: Readonly<Record<string, string | undefined>> = process.env,
  where: (def: SettingDef) => boolean = () => true,
): Promise<{ readonly editable: boolean; readonly owner: boolean; readonly settings: readonly SettingView[] }> {
  const [deployment, workspace] = await Promise.all([readSettingsDoc(DEPLOYMENT_KEY), readSettingsDoc(workspaceKey(caller.workspaceId))]);
  const editable = settingsEditable(base);
  const settings = SETTINGS.filter((def) => def.page !== "models" && where(def) && (caller.owner || (def.scope === "workspace" && def.sensitive !== true))).map((def): SettingView => {
    const doc = def.scope === "deployment" ? deployment : workspace;
    const saved = def.kind.type === "secret" ? (doc.sealed[def.env] ?? null) : (doc.values[def.env] ?? null);
    const fromEnv = base[def.env]?.trim() || null;
    const isSecret = def.kind.type === "secret";
    return {
      env: def.env,
      area: def.area,
      label: def.label,
      help: def.help,
      scope: def.scope,
      tier: def.tier,
      kind: def.kind,
      fallback: def.fallback,
      value: isSecret ? null : (saved ?? fromEnv),
      source: saved !== null ? "setting" : fromEnv !== null ? "env" : "default",
      isSet: saved !== null || fromEnv !== null,
      overridesEnv: saved !== null && fromEnv !== null,
      editable: editable && (def.scope === "workspace" || caller.owner),
    };
  });
  return { editable, owner: caller.owner, settings };
}

/** Whether the saved settings turn the background worker's pause on, cheaply (one cached read). */
export async function workerPaused(): Promise<boolean> {
  const doc = await readSettingsDoc(DEPLOYMENT_KEY);
  return doc.values.BOT_WORKER === "off" && on(process.env.BOT_WORKER);
}

/** For tests. */
export function forgetSettings(): void {
  cache.clear();
}
