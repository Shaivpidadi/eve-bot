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
 * `BOT_ENGINES` is an environment variable only, never a Settings page
 * switch: it decides at build time whether the harness's queue route is built
 * at all (see `next.config.ts`), so a deployment that leaves it unset builds
 * and runs exactly as before. Off by default.
 *
 * This module is plain data and checks: nothing here loads durable-harness.
 */

/** What can run a Bot's jobs. `eve` is the default and needs no switch. */
export const ENGINES = ["eve", "claude-code", "codex"] as const;
export type Engine = (typeof ENGINES)[number];
/** The engines a switch can turn on: every one but eve. */
export type HarnessEngine = Exclude<Engine, "eve">;

const HARNESS_ENGINES: readonly HarnessEngine[] = ["claude-code", "codex"];

export const ENGINE_LABELS: Readonly<Record<Engine, string>> = {
  eve: "eve (the team's computer)",
  "claude-code": "Claude Code (its own sandbox, no browser)",
  codex: "Codex (its own sandbox, no browser)",
};

/** The engine's name alone, for sentences. */
export const ENGINE_NAMES: Readonly<Record<Engine, string>> = { eve: "eve", "claude-code": "Claude Code", codex: "Codex" };

/**
 * Where each engine's session log keeps its model spend (H0 and H4): a journal
 * stream of `{ usd, model }` records, one per model call.
 */
export const SPEND_STREAMS: Readonly<Record<HarnessEngine, string>> = { "claude-code": "hw.spend", codex: "codex.spend" };

type Env = Readonly<Record<string, string | undefined>>;

/** The engines `BOT_ENGINES` turns on: a comma-separated list, or `off`. Unknown names are ignored. */
export function enabledEngines(env: Env = process.env): readonly HarnessEngine[] {
  const raw = (env.BOT_ENGINES ?? "").trim().toLowerCase();
  if (raw === "" || raw === "off" || raw === "0" || raw === "false") return [];
  const named = raw.split(",").map((part) => part.trim());
  return HARNESS_ENGINES.filter((engine) => named.includes(engine));
}

export const enginesOn = (env: Env = process.env): boolean => enabledEngines(env).length > 0;

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
  return null;
}
