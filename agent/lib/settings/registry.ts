/**
 * Every setting the console can change, keyed by the environment variable it
 * stands in for (see `docs/plan/settings-ui.md`).
 *
 * A saved value is stored as the same string the variable would hold, and
 * `effectiveEnv` lays the saved values over `process.env`, so each reader keeps
 * parsing it exactly as it parses the variable. What is not listed here stays
 * an environment variable only: what the console itself depends on (where
 * settings are stored, who may sign in, build switches) and security fences.
 */

export type SettingScope = "deployment" | "workspace";

/** When a change takes effect: at once (or from the next turn or job), at the computer's or browser's next start, or with the next build. */
export type SettingTier = "live" | "next-start" | "rebuild";

export type SettingKind =
  | { readonly type: "number"; readonly min?: number; readonly max?: number; readonly integer?: boolean; readonly unit?: string }
  | { readonly type: "switch" }
  | { readonly type: "text"; readonly placeholder?: string; readonly max?: number }
  | { readonly type: "list"; readonly placeholder?: string }
  | { readonly type: "choice"; readonly options: readonly { readonly value: string; readonly label: string }[] }
  | { readonly type: "secret" };

export type SettingArea =
  | "Spend"
  | "Models"
  | "Memory & decisions"
  | "Team computer"
  | "Browser"
  | "Email"
  | "Background work"
  | "Team"
  | "Data controls";

/** Where a setting means anything: everywhere, on Vercel's computer, on a local one, or with the background worker deployed on. */
export type SettingWhere = "always" | "vercel-computer" | "local-computer" | "worker";

export interface SettingDef {
  readonly env: string;
  readonly area: SettingArea;
  readonly label: string;
  readonly help: string;
  readonly scope: SettingScope;
  readonly tier: SettingTier;
  readonly kind: SettingKind;
  /** The default in words, for the page: what applies when neither the console nor the environment sets it. */
  readonly fallback: string;
  readonly where?: SettingWhere;
  /** Shown only to the owner, never to a tenant: it can carry an address or a token. */
  readonly sensitive?: boolean;
  /** Edited on its own page (the Models page), not the generic one. */
  readonly page?: "models";
}

const usd = { type: "number", min: 0, unit: "USD" } as const;
const minutes = (max: number) => ({ type: "number", min: 1, max, integer: true, unit: "minutes" }) as const;
const ms = (max: number) => ({ type: "number", min: 0, max, integer: true, unit: "ms" }) as const;
const SWITCH = { type: "switch" } as const;
const REASONING = {
  type: "choice",
  options: [
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High" },
    { value: "xhigh", label: "Extra high" },
  ],
} as const;

export const SETTINGS: readonly SettingDef[] = [
  // ─── Spend ───────────────────────────────────────────────────────────────
  { env: "BOT_BUDGET_MONTHLY_USD", area: "Spend", label: "Monthly budget", help: "The most the workspace may spend on models (and the computer, once its rate is set) in a month. A run that would not fit waits with the reason.", scope: "workspace", tier: "live", kind: usd, fallback: "No limit" },
  { env: "BOT_BUDGET_DAILY_USD", area: "Spend", label: "Daily budget", help: "The same, for one day.", scope: "workspace", tier: "live", kind: usd, fallback: "No limit" },
  { env: "BOT_HQ_COST_LIMIT_USD", area: "Spend", label: "Most one HQ thread may spend", help: "A runaway stop for one conversation with HQ.", scope: "deployment", tier: "rebuild", kind: usd, fallback: "$10" },
  { env: "BOT_JOB_COST_LIMIT_USD", area: "Spend", label: "Most one job may spend", help: "A runaway stop for one Bot's job.", scope: "deployment", tier: "rebuild", kind: usd, fallback: "$5" },
  { env: "BOT_HQ_INPUT_TOKEN_LIMIT", area: "Spend", label: "HQ input token cap", help: "Backs the dollar cap up on an endpoint that reports no prices. 0 or off: no cap.", scope: "deployment", tier: "rebuild", kind: { type: "number", min: 0, integer: true, unit: "tokens" }, fallback: "40,000,000" },
  { env: "BOT_HQ_OUTPUT_TOKEN_LIMIT", area: "Spend", label: "HQ output token cap", help: "As above, for what HQ writes.", scope: "deployment", tier: "rebuild", kind: { type: "number", min: 0, integer: true, unit: "tokens" }, fallback: "2,000,000" },
  { env: "BOT_JOB_INPUT_TOKEN_LIMIT", area: "Spend", label: "Job input token cap", help: "As above, for one job.", scope: "deployment", tier: "rebuild", kind: { type: "number", min: 0, integer: true, unit: "tokens" }, fallback: "10,000,000" },
  { env: "BOT_JOB_OUTPUT_TOKEN_LIMIT", area: "Spend", label: "Job output token cap", help: "As above, for what one job writes.", scope: "deployment", tier: "rebuild", kind: { type: "number", min: 0, integer: true, unit: "tokens" }, fallback: "500,000" },
  { env: "BOT_COMPUTER_USD_PER_HOUR", area: "Spend", label: "Computer cost per hour", help: "What the team's computer costs while it runs, so its time counts against the budget. Unset: its time is not counted.", scope: "deployment", tier: "live", kind: usd, fallback: "Not counted" },
  { env: "BOT_COMPUTER_USD_PER_CPU_HOUR", area: "Spend", label: "Computer cost per active CPU hour", help: "Vercel Sandbox bills active CPU; adds to the hourly rate.", scope: "deployment", tier: "live", kind: usd, fallback: "Not counted" },
  { env: "BOT_COMPUTER_USD_PER_GB_HOUR", area: "Spend", label: "Computer cost per GB-hour of memory", help: "Vercel Sandbox bills provisioned memory; adds to the hourly rate.", scope: "deployment", tier: "live", kind: usd, fallback: "Not counted" },
  { env: "BOT_MODEL_PRICES", area: "Spend", label: "Model prices off AI Gateway", help: "model=input/output USD per million tokens, comma separated, so spend caps hold on your own endpoint.", scope: "deployment", tier: "live", kind: { type: "text", placeholder: "my/model=0.5/1.5" }, fallback: "Read from OpenRouter, else unknown" },

  // ─── Models (edited on the Models page) ──────────────────────────────────
  { env: "BOT_HQ_MODEL", area: "Models", label: "HQ's model", help: "", scope: "workspace", tier: "live", kind: { type: "text" }, fallback: "anthropic/claude-sonnet-5", page: "models" },
  { env: "BOT_TEAMMATE_MODEL", area: "Models", label: "Every job's model", help: "", scope: "workspace", tier: "live", kind: { type: "text" }, fallback: "By effort", page: "models" },
  { env: "BOT_MODEL_QUICK", area: "Models", label: "Quick jobs' model", help: "", scope: "workspace", tier: "live", kind: { type: "text" }, fallback: "alibaba/qwen3.8-flash", page: "models" },
  { env: "BOT_MODEL_STANDARD", area: "Models", label: "Standard jobs' model", help: "", scope: "workspace", tier: "live", kind: { type: "text" }, fallback: "anthropic/claude-sonnet-5", page: "models" },
  { env: "BOT_MODEL_DEEP", area: "Models", label: "Deep jobs' model", help: "", scope: "workspace", tier: "live", kind: { type: "text" }, fallback: "anthropic/claude-opus-5", page: "models" },
  { env: "BOT_MEMORY_MODEL", area: "Models", label: "Helper's model", help: "", scope: "workspace", tier: "live", kind: { type: "text" }, fallback: "anthropic/claude-haiku-4-5", page: "models" },
  { env: "BOT_HQ_REASONING", area: "Models", label: "HQ's reasoning", help: "How hard HQ thinks before it answers. On AI Gateway; fixed at build on your own endpoint.", scope: "workspace", tier: "live", kind: REASONING, fallback: "Low" },
  { env: "BOT_TEAMMATE_REASONING", area: "Models", label: "Bots' reasoning", help: "How hard a Bot thinks at each step of a job. On AI Gateway; fixed at build on your own endpoint.", scope: "workspace", tier: "live", kind: REASONING, fallback: "Medium" },

  // ─── Memory & decisions ──────────────────────────────────────────────────
  { env: "BOT_MEMORY_FLOOR", area: "Memory & decisions", label: "How sure memory must be", help: "How confident the decision model must be before a memory is kept, from 0 to 1.", scope: "workspace", tier: "live", kind: { type: "number", min: 0, max: 1 }, fallback: "Jev's own floor" },
  { env: "BOT_MEMORY_EMBEDDINGS", area: "Memory & decisions", label: "Find memories by meaning", help: "Ranks memories by meaning with embeddings, not just words. A small charge per memory.", scope: "deployment", tier: "live", kind: SWITCH, fallback: "On" },
  { env: "BOT_MEMORY_EMBEDDING_MODEL", area: "Memory & decisions", label: "Embedding model", help: "The model that turns memories into vectors.", scope: "deployment", tier: "live", kind: { type: "text", placeholder: "openai/text-embedding-3-small" }, fallback: "openai/text-embedding-3-small" },
  { env: "BOT_JEV", area: "Memory & decisions", label: "Second opinion on small decisions", help: "Jev, a decision model, answers small questions (is this a sign-in wall, does this result meet the brief) as a probability. Off: those checks are skipped.", scope: "deployment", tier: "live", kind: SWITCH, fallback: "On" },
  { env: "BOT_JEV_MODEL", area: "Memory & decisions", label: "Decision model", help: "Another decision model on AI Gateway.", scope: "deployment", tier: "live", kind: { type: "text", placeholder: "typesafe-ai/jev" }, fallback: "typesafe-ai/jev" },
  { env: "BOT_JEV_CONFIDENCE", area: "Memory & decisions", label: "How sure a decision must be", help: "Below this, the decision is not taken, from 0 to 1.", scope: "deployment", tier: "live", kind: { type: "number", min: 0, max: 1 }, fallback: "0.8" },

  // ─── Team computer ───────────────────────────────────────────────────────
  { env: "BOT_COMPUTER_IDLE_MINUTES", area: "Team computer", label: "Stop an idle browser after", help: "A browser nobody used for this long is stopped; it starts again on the next use.", scope: "deployment", tier: "live", kind: minutes(24 * 60), fallback: "15 minutes" },
  { env: "BOT_COMPUTER_MAX_SCREENS", area: "Team computer", label: "Screens at once", help: "One per Bot at a time, reclaimed from the least recently used. About 0.5 GB of memory each.", scope: "deployment", tier: "live", kind: { type: "number", min: 1, max: 9, integer: true }, fallback: "4" },
  { env: "BOT_COMPUTER_CONTROL_MINUTES", area: "Team computer", label: "Longest a person may take over", help: "How long one person may hold a Bot's browser in one go.", scope: "deployment", tier: "live", kind: minutes(240), fallback: "30 minutes" },
  { env: "BOT_COMPUTER_TOKEN_TTL_SECONDS", area: "Team computer", label: "Live view links last", help: "Each live connection carries a single-use token this short-lived.", scope: "deployment", tier: "live", kind: { type: "number", min: 10, max: 600, integer: true, unit: "seconds" }, fallback: "60 seconds" },
  { env: "BOT_BACKUP_EVERY_MINUTES", area: "Team computer", label: "Back the computer up every", help: "While Bots work, and at every job's end.", scope: "deployment", tier: "live", kind: minutes(24 * 60), fallback: "10 minutes (60 with a drive)" },
  { env: "BOT_BACKUP_MAX_MB", area: "Team computer", label: "Largest backup", help: "A backup bigger than this, compressed, is refused with the reason.", scope: "deployment", tier: "live", kind: { type: "number", min: 16, max: 4096, integer: true, unit: "MB" }, fallback: "512 MB" },
  { env: "BOT_COMPUTER_DRIVE", area: "Team computer", label: "Keep work on a Vercel Drive", help: "The work folders and browser profiles live on a drive, so a lost machine loses nothing. Applies from the computer's next start.", scope: "deployment", tier: "next-start", kind: SWITCH, fallback: "Off", where: "vercel-computer" },
  { env: "BOT_COMPUTER_DRIVE_GB", area: "Team computer", label: "Drive size", help: "Applies when the drive is made.", scope: "deployment", tier: "next-start", kind: { type: "number", min: 1, integer: true, unit: "GB" }, fallback: "Vercel's default", where: "vercel-computer" },
  { env: "BOT_SANDBOX_VCPUS", area: "Team computer", label: "CPUs", help: "2 GB of memory per CPU. From the computer's next session.", scope: "deployment", tier: "next-start", kind: { type: "number", min: 1, max: 8, integer: true }, fallback: "4" },
  { env: "BOT_SANDBOX_TIMEOUT_MINUTES", area: "Team computer", label: "Computer stays up for", help: "How long the computer runs between uses before it idles out. Applied to the running computer.", scope: "deployment", tier: "next-start", kind: minutes(5 * 60), fallback: "30 minutes", where: "vercel-computer" },
  { env: "BOT_SANDBOX_ALLOW_DOMAINS", area: "Team computer", label: "Sites the computer may reach", help: "Comma separated; empty allows all. Applied at the firewall, outside the computer. On a local computer, from its next start.", scope: "deployment", tier: "next-start", kind: { type: "list", placeholder: "*.github.com, api.linear.app" }, fallback: "Everything" },
  { env: "BOT_COMPUTER_CHROME_FLAGS", area: "Team computer", label: "Extra Chrome flags", help: "From the browser's next start, e.g. --lang=en-GB.", scope: "deployment", tier: "next-start", kind: { type: "text", placeholder: "--lang=en-GB" }, fallback: "None" },
  { env: "BOT_COMPUTER_APT_MIRROR", area: "Team computer", label: "Package mirror", help: "An Ubuntu mirror for installing the computer's software, when Ubuntu's own archive can't be reached.", scope: "deployment", tier: "next-start", kind: { type: "text", placeholder: "https://mirrors.edge.kernel.org/ubuntu" }, fallback: "mirrors.edge.kernel.org" },
  { env: "BOT_BROWSER_PROXY", area: "Team computer", label: "Browser proxy", help: "The browser's traffic goes through this proxy, from its next start.", scope: "deployment", tier: "next-start", kind: { type: "text", placeholder: "http://proxy.example:8080" }, fallback: "None", sensitive: true },
  { env: "BOT_SHELL_TCP_PORTS", area: "Team computer", label: "Extra ports the shell may reach", help: "Comma separated, e.g. 5432,6379. From the shell fence's next setup.", scope: "deployment", tier: "next-start", kind: { type: "list", placeholder: "5432, 6379" }, fallback: "The defaults" },
  { env: "BOT_COMPUTER_IMAGE", area: "Team computer", label: "Computer image", help: "Where the computer's software comes from: a Vercel Container Registry image, or default. Machines are built from it, so it applies with the next build.", scope: "deployment", tier: "rebuild", kind: { type: "text", placeholder: "vcr.vercel.com/team/project/bot-computer:latest" }, fallback: "Install on first boot (Vercel), the Dockerfile (local)" },
  { env: "BOT_COMPUTER", area: "Team computer", label: "Where the computer runs", help: "Vercel Sandbox, or this machine. Applies with the next build.", scope: "deployment", tier: "rebuild", kind: { type: "choice", options: [{ value: "vercel", label: "Vercel Sandbox" }, { value: "local", label: "This machine" }] }, fallback: "Vercel Sandbox" },
  { env: "BOT_COMPUTER_LOCAL", area: "Team computer", label: "Local computer", help: "Docker, which the console can watch, or a microsandbox VM. Applies with the next build.", scope: "deployment", tier: "rebuild", kind: { type: "choice", options: [{ value: "docker", label: "Docker" }, { value: "microsandbox", label: "microsandbox VM" }] }, fallback: "Docker", where: "local-computer" },
  { env: "BOT_COMPUTER_LOCAL_PORT", area: "Team computer", label: "Local live view port", help: "Applies with the next build.", scope: "deployment", tier: "rebuild", kind: { type: "number", min: 1024, max: 65535, integer: true }, fallback: "16080", where: "local-computer" },
  { env: "BOT_COMPUTER_LOCAL_BIND", area: "Team computer", label: "Local live view address", help: "127.0.0.1 keeps it to this machine; 0.0.0.0 lets other devices watch. Applies with the next build.", scope: "deployment", tier: "rebuild", kind: { type: "text", placeholder: "127.0.0.1" }, fallback: "127.0.0.1", where: "local-computer" },
  { env: "BOT_COMPUTER_FORWARDER_IMAGE", area: "Team computer", label: "Local forwarder image", help: "The small container that publishes the live view. Applies with the next build.", scope: "deployment", tier: "rebuild", kind: { type: "text", placeholder: "alpine/socat" }, fallback: "alpine/socat", where: "local-computer" },

  // ─── Browser ─────────────────────────────────────────────────────────────
  { env: "BOT_BROWSER_ALLOWED_DOMAINS", area: "Browser", label: "Sites Bots may open", help: "Comma separated; empty allows all. Checked on every page a Bot opens.", scope: "deployment", tier: "live", kind: { type: "list", placeholder: "*.notion.so, linear.app" }, fallback: "Everything" },
  { env: "BOT_BROWSER_PAGE_CHARS", area: "Browser", label: "How much of a page a Bot reads per look", help: "In characters.", scope: "deployment", tier: "live", kind: { type: "number", min: 1000, max: 100_000, integer: true, unit: "characters" }, fallback: "8,000" },
  { env: "BOT_BROWSER_SETTLE_MS", area: "Browser", label: "Wait for the page to settle", help: "Before each look.", scope: "deployment", tier: "live", kind: ms(10_000), fallback: "300 ms" },
  { env: "BOT_BROWSER_GUARD_MS", area: "Browser", label: "Watch what a click sends for", help: "After a click, the network guard watches what the page sends this long.", scope: "deployment", tier: "live", kind: { type: "number", min: 200, max: 10_000, integer: true, unit: "ms" }, fallback: "1,200 ms" },
  { env: "BOT_BROWSER_MAX_OUTPUT", area: "Browser", label: "Longest browser answer", help: "In characters; longer answers are cut.", scope: "deployment", tier: "live", kind: { type: "number", min: 1000, max: 200_000, integer: true, unit: "characters" }, fallback: "20,000" },
  { env: "BOT_PILOT_SECONDS", area: "Browser", label: "Longest page pilot", help: "How long a Bot may drive a page in one go.", scope: "deployment", tier: "live", kind: { type: "number", min: 10, max: 600, integer: true, unit: "seconds" }, fallback: "60 seconds" },

  // ─── Email ───────────────────────────────────────────────────────────────
  { env: "BOT_EMAIL_WEBHOOK", area: "Email", label: "Email webhook", help: "Where a Bot's send_email posts (Zapier, Make, n8n, your own). Empty: Bots can't send email.", scope: "deployment", tier: "live", kind: { type: "text", placeholder: "https://hooks.example.com/…" }, fallback: "Not set", sensitive: true },
  { env: "BOT_EMAIL_WEBHOOK_TOKEN", area: "Email", label: "Webhook token", help: "Sent as a bearer token. Stored sealed; never shown again.", scope: "deployment", tier: "live", kind: { type: "secret" }, fallback: "None", sensitive: true },
  { env: "BOT_EMAIL_WEBHOOK_TIMEOUT_MS", area: "Email", label: "Webhook timeout", help: "How long to wait for the sender to answer.", scope: "deployment", tier: "live", kind: { type: "number", min: 1000, max: 120_000, integer: true, unit: "ms" }, fallback: "30,000 ms" },

  // ─── Background work ─────────────────────────────────────────────────────
  { env: "BOT_WORKER", area: "Background work", label: "Background worker", help: "Does the watchdog's work every few seconds, so nothing waits for a console. Turned on for the deployment with BOT_WORKER=on; here it can be paused.", scope: "deployment", tier: "live", kind: SWITCH, fallback: "On", where: "worker" },
  { env: "BOT_WORKER_EVERY_SECONDS", area: "Background work", label: "Worker runs every", help: "Each pass is about 3 Blob operations.", scope: "deployment", tier: "live", kind: { type: "number", min: 10, max: 3600, integer: true, unit: "seconds" }, fallback: "30 seconds", where: "worker" },
  { env: "BOT_TICK_BATCH", area: "Background work", label: "Jobs started per pass", help: "How many due jobs the watchdog starts at once.", scope: "deployment", tier: "live", kind: { type: "number", min: 1, max: 100, integer: true }, fallback: "10" },

  // ─── Team ────────────────────────────────────────────────────────────────
  { env: "BOT_TIMEZONE", area: "Team", label: "Timezone", help: "For routines and standups, an IANA name such as Europe/Berlin.", scope: "workspace", tier: "live", kind: { type: "text", placeholder: "America/New_York" }, fallback: "The server's" },
  { env: "BOT_DEFAULT_BOT_NAME", area: "Team", label: "First Bot's name", help: "The Bot a new workspace starts with.", scope: "workspace", tier: "live", kind: { type: "text", max: 40 }, fallback: "Atlas" },
  { env: "BOT_STANDUP_ROOM", area: "Team", label: "Standup thread", help: "Where the daily standup is posted.", scope: "deployment", tier: "live", kind: { type: "text", placeholder: "desk" }, fallback: "HQ's thread" },
  { env: "BOT_ACTIVITY_RETAIN", area: "Team", label: "Activity kept", help: "How many feed entries each workspace keeps.", scope: "deployment", tier: "live", kind: { type: "number", min: 50, max: 10_000, integer: true, unit: "entries" }, fallback: "500" },

  // ─── Data controls ───────────────────────────────────────────────────────
  { env: "BOT_ZDR", area: "Data controls", label: "Zero Data Retention", help: "Only AI Gateway providers that keep nothing serve calls (Pro and Enterprise). Free models offer none.", scope: "deployment", tier: "live", kind: SWITCH, fallback: "Off" },
  { env: "BOT_INFERENCE_REGION", area: "Data controls", label: "Keep inference in", help: "Gateway fails a call it can't serve there rather than run it elsewhere.", scope: "deployment", tier: "live", kind: { type: "choice", options: [{ value: "us", label: "United States" }, { value: "eu", label: "Europe" }] }, fallback: "Anywhere" },
  { env: "BOT_EXPORT", area: "Data controls", label: "Export from the console", help: "Lets the owner download the workspace as an export file.", scope: "deployment", tier: "live", kind: SWITCH, fallback: "Off" },
  { env: "BOT_UPDATE_CHECK", area: "Data controls", label: "Check for updates", help: "The console asks GitHub whether a newer version is out.", scope: "deployment", tier: "live", kind: SWITCH, fallback: "On" },
];

export const SETTINGS_BY_ENV: ReadonlyMap<string, SettingDef> = new Map(SETTINGS.map((def) => [def.env, def]));

/**
 * A value as the setting stores it (the variable's string), or why it is not one.
 * Switches store `on` / `off`; lists are trimmed and comma joined.
 */
export function normalizeValue(def: SettingDef, raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
  const kind = def.kind;
  if (kind.type === "switch") {
    if (typeof raw === "boolean") return { ok: true, value: raw ? "on" : "off" };
    if (typeof raw === "string" && /^(on|off)$/i.test(raw.trim())) return { ok: true, value: raw.trim().toLowerCase() };
    return { ok: false, error: `${def.label} is on or off.` };
  }
  if (kind.type === "number") {
    const value = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw.trim()) : Number.NaN;
    if (!Number.isFinite(value)) return { ok: false, error: `${def.label} is a number.` };
    if (kind.integer === true && !Number.isInteger(value)) return { ok: false, error: `${def.label} is a whole number.` };
    if (kind.min !== undefined && value < kind.min) return { ok: false, error: `${def.label} is at least ${kind.min}.` };
    if (kind.max !== undefined && value > kind.max) return { ok: false, error: `${def.label} is at most ${kind.max}.` };
    return { ok: true, value: String(value) };
  }
  if (typeof raw !== "string") return { ok: false, error: `${def.label} is text.` };
  const text = raw.trim();
  if (kind.type === "choice") {
    return kind.options.some((option) => option.value === text) ? { ok: true, value: text } : { ok: false, error: `${def.label} is one of ${kind.options.map((option) => option.label).join(", ")}.` };
  }
  if (kind.type === "list") {
    const items = text.split(",").map((item) => item.trim()).filter((item) => item !== "");
    if (items.some((item) => !/^[\w.*:/-]+$/.test(item))) return { ok: false, error: `${def.label} is a comma-separated list of names.` };
    return { ok: true, value: items.join(",") };
  }
  const max = kind.type === "text" && kind.max !== undefined ? kind.max : 2_000;
  if (text.length > max) return { ok: false, error: `${def.label} is at most ${max} characters.` };
  // Nothing that could break out of an environment-style value.
  if (/[\u0000-\u001f]/.test(text)) return { ok: false, error: `${def.label} has a character it can't hold.` };
  return { ok: true, value: text };
}
