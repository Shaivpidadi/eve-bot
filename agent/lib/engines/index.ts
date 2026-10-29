/**
 * Which engine runs a Bot's jobs (see `docs/plan/harness-engines.md`).
 *
 * Every Bot runs on eve unless the owner turned another engine on for this
 * deployment and gave that Bot the engine. The other engines are Claude Code
 * and Codex, through `durable-harness`: the CLI runs in a Vercel Sandbox of
 * its own for each job, not on the team's computer, and reaches the outside
 * world only through the few eve-bot tools it is given. Both bill through AI
 * Gateway, like eve's own calls: no Claude or ChatGPT subscription is used.
 *
 * `BOT_ENGINES` is set on the Settings page (Engines) or in the environment,
 * and applies with the next build: it decides whether the harness's queue
 * route is built at all (see `next.config.ts`), so a deployment that leaves it
 * unset builds and runs exactly as before. Off by default.
 *
 * This module is plain data and checks: nothing here loads durable-harness.
 */

// First: the build's Settings values over the environment, before anything below reads it (see settings/built.ts).
import "../settings/built";

/**
 * What can run a Bot's jobs. `eve` is the default and needs no switch.
 * `claude-code` and `codex` run through durable-harness in a Vercel Sandbox of
 * their own (`BOT_ENGINES`); `claude-code-local` and `codex-local` run the CLI
 * on the team's computer of a standalone server, signed in with the owner's
 * own Claude or ChatGPT plan (see `./local`).
 */
export const ENGINES = ["eve", "claude-code", "codex", "claude-code-local", "codex-local"] as const;
export type Engine = (typeof ENGINES)[number];
/** Every engine but eve. */
export type HarnessEngine = Exclude<Engine, "eve">;
/** The engines durable-harness runs, on Vercel Sandbox. */
export type DurableEngine = "claude-code" | "codex";
/** The engines that run the CLI on the team's computer, on the owner's plan. */
export type LocalEngine = "claude-code-local" | "codex-local";

const HARNESS_ENGINES: readonly DurableEngine[] = ["claude-code", "codex"];
export const LOCAL_ENGINES: readonly LocalEngine[] = ["claude-code-local", "codex-local"];

export const isLocalEngine = (engine: Engine): engine is LocalEngine => (LOCAL_ENGINES as readonly string[]).includes(engine);

export const ENGINE_LABELS: Readonly<Record<Engine, string>> = {
  eve: "eve (the team's computer)",
  "claude-code": "Claude Code (its own sandbox, no browser)",
  codex: "Codex (its own sandbox, no browser)",
  "claude-code-local": "Claude Code on your plan (the team's computer)",
  "codex-local": "Codex on your plan (the team's computer)",
};

/** The engine's name alone, for sentences. */
export const ENGINE_NAMES: Readonly<Record<Engine, string>> = {
  eve: "eve",
  "claude-code": "Claude Code",
  codex: "Codex",
  "claude-code-local": "Claude Code",
  "codex-local": "Codex",
};

/**
 * Where each engine's session log keeps its model spend (H0 and H4): a journal
 * stream of `{ usd, model }` records, one per model call.
 */
export const SPEND_STREAMS: Readonly<Record<DurableEngine, string>> = { "claude-code": "hw.spend", codex: "codex.spend" };

type Env = Readonly<Record<string, string | undefined>>;

/** The engines `BOT_ENGINES` turns on: a comma-separated list, or `off`. Unknown names are ignored. */
export function enabledEngines(env: Env = process.env): readonly DurableEngine[] {
  const raw = (env.BOT_ENGINES ?? "").trim().toLowerCase();
  if (raw === "" || raw === "off" || raw === "0" || raw === "false") return [];
  const named = raw.split(",").map((part) => part.trim());
  return HARNESS_ENGINES.filter((engine) => named.includes(engine));
}

export const enginesOn = (env: Env = process.env): boolean => enabledEngines(env).length > 0;

/** Whether a Bot could run on the owner's own plan here: a standalone server with the team's computer on this machine. */
export const localEnginesPossible = (env: Env = process.env): boolean => env.VERCEL !== "1" && (env.BOT_COMPUTER ?? "").trim() === "local";

/** Whether HQ is offered an engine to give a Bot: one turned on for the deployment, or the owner's plan possible here. */
export const engineChoiceOffered = (env: Env = process.env): boolean => enginesOn(env) || localEnginesPossible(env);

export function isEngine(value: unknown): value is Engine {
  return typeof value === "string" && (ENGINES as readonly string[]).includes(value);
}

/** The engine a Bot runs on: eve unless it was given another. */
export function engineOf(bot: { readonly engine?: Engine | undefined } | null | undefined): Engine {
  return bot?.engine ?? "eve";
}

const truthy = (value: string | undefined): boolean => /^(1|true|on|yes)$/i.test(value?.trim() ?? "");

/** The engines this workspace may give a Bot: always eve, and any other the owner turned on and nothing refuses here. */
export function engineChoices(workspaceId: string, env: Env = process.env): readonly Engine[] {
  return ENGINES.filter((engine) => engineRefusal(engine, { workspaceId, env }) === null);
}

/**
 * Why a harness engine cannot run here, in words for the person, or null when
 * it can. Checked when a Bot is given the engine and again when each job
 * starts, so turning a data control on later stops harness jobs at once.
 *
 * - The switch: off unless `BOT_ENGINES` names the engine.
 * - The owner's workspace only: a tenant cannot start Sandboxes on the
 *   owner's account.
 * - Data controls: `BOT_ZDR` and `BOT_INFERENCE_REGION` travel as Gateway
 *   provider options, which the harness's model route has no way to pass on
 *   (plan, section 4.5). A deployment that asked for them never gets a
 *   harness Bot quietly without them.
 * - A custom model endpoint: the harness speaks only to AI Gateway.
 */
export function engineRefusal(
  engine: Engine,
  context: { readonly workspaceId: string; readonly env?: Env },
): string | null {
  if (engine === "eve") return null;
  const env = context.env ?? process.env;
  if (isLocalEngine(engine)) return localEngineRefusal(engine, context.workspaceId, env);
  if (!enabledEngines(env).includes(engine)) {
    return `The ${ENGINE_LABELS[engine]} engine is off on this deployment. The owner turns it on with BOT_ENGINES=${engine}.`;
  }
  const owners = env.BOT_DEFAULT_WORKSPACE ?? "default";
  if (context.workspaceId !== owners) {
    return "Only the owner's workspace can run Bots on another engine.";
  }
  const name = ENGINE_NAMES[engine];
  if (truthy(env.BOT_ZDR)) {
    return `Zero Data Retention (BOT_ZDR) is on, and ${name} jobs cannot carry it. Turn it off, or keep this Bot on eve.`;
  }
  if ((env.BOT_INFERENCE_REGION ?? "").trim() !== "") {
    return `An inference region (BOT_INFERENCE_REGION) is set, and ${name} jobs cannot carry it. Unset it, or keep this Bot on eve.`;
  }
  if ((env.BOT_MODEL_BASE_URL ?? "").trim() !== "") {
    return `This deployment uses its own model endpoint (BOT_MODEL_BASE_URL), and ${name} jobs run only through AI Gateway.`;
  }
  if (!hasSandboxCredentials(env)) {
    return `Each ${name} job runs in a Vercel Sandbox, and this server has no Vercel credentials for one: run "vercel link && vercel env pull" (a VERCEL_OIDC_TOKEN, good for 12 hours), or set VERCEL_TOKEN with VERCEL_TEAM_ID and VERCEL_PROJECT_ID.`;
  }
  return null;
}

/**
 * Why a plan engine cannot run here, or null when it can (see `./local`):
 * only on a standalone server's own computer, only for the owner (it is the
 * owner's plan), and only once the owner saved a sign-in for it in Settings.
 */
function localEngineRefusal(engine: LocalEngine, workspaceId: string, env: Env): string | null {
  const name = ENGINE_NAMES[engine];
  if (env.VERCEL === "1") return `${name} on your own plan runs on a standalone server's computer. On Vercel, a Bot runs ${name} in a Sandbox of its own instead.`;
  if ((env.BOT_COMPUTER ?? "").trim() !== "local") return `${name} on your own plan runs on the team's computer on this machine (BOT_COMPUTER=local).`;
  const owners = env.BOT_DEFAULT_WORKSPACE ?? "default";
  if (workspaceId !== owners) return `Only the owner's workspace can run Bots on the owner's own ${name} plan.`;
  const signedIn = engine === "claude-code-local" ? (env.BOT_LOCAL_CLAUDE_TOKEN ?? "").trim() !== "" : (env.BOT_LOCAL_CODEX_AUTH ?? "").trim() !== "" || (env.BOT_LOCAL_CODEX_API_KEY ?? "").trim() !== "";
  if (!signedIn) {
    return engine === "claude-code-local"
      ? `${name} needs your sign-in: run "claude setup-token" and save the token in Settings → Engines.`
      : `${name} needs your sign-in: run "codex login --device-auth", then save the contents of ~/.codex/auth.json in Settings → Engines.`;
  }
  return null;
}

/** Whether a job's Sandbox can be made from here: on Vercel, or with credentials a standalone server was given. */
function hasSandboxCredentials(env: Env): boolean {
  const set = (name: string) => (env[name] ?? "").trim() !== "";
  return env.VERCEL === "1" || set("VERCEL_OIDC_TOKEN") || (set("VERCEL_TOKEN") && (set("VERCEL_TEAM_ID") || set("VERCEL_ORG_ID")) && set("VERCEL_PROJECT_ID"));
}
