import {
  AgentBrowserCommandError,
  installAgentBrowser,
  runAgentBrowser,
} from "@agent-browser/eve/sandbox";
import { AGENT_BROWSER_SANDBOX_VERSION } from "@agent-browser/sandbox";
import type { ToolContext } from "eve/tools";

import { COMPUTER_PATHS } from "../../../lib/computer";
import { AGENT_BROWSER_INSTALL } from "../../../lib/computer-config";
import { GUARD_TTL_MS, guardGraceMs, NETGUARD_FILE, parseGuardAnswer, type Stopped } from "../../../lib/computer/netguard";
import { ComputerError, currentKind, lacking, shellQuote, toolHands } from "../../../lib/hands";
import { COMPUTER_BIN } from "../../../lib/computer/script";
import {
  allocateScreen,
  bindSession,
  liveControl,
  noteRunTab,
  screenPorts,
  sessionBinding,
  setBotTab,
  setBrowserState,
  setPosterAt,
  teamScreen,
  touchScreen,
  type ServiceState,
  type SessionBinding,
} from "../../../lib/computer/screens";
import { posterKey, saveScreen } from "../../../lib/screens";
import { operator } from "../../../lib/session";
import { journal } from "./journal";
import { keepRecording } from "./recording";
import { sessionState } from "./session-state";
import { within } from "../../../lib/cancel";
import { closeFinishedTabs } from "../../../lib/computer/tab-sweep";
import { effectiveEnv } from "../../../lib/settings/store";

/**
 * The Bot's browser: the Google Chrome on the team's one screen, which every
 * Bot shares and the operator can watch live and take over from any thread.
 *
 * agent-browser attaches to that Chrome over DevTools and speaks in
 * accessibility snapshots with stable `@ref` handles, which is what makes a web
 * app usable by a model: it reads the page the way a screen reader does and acts
 * on named elements rather than pixel coordinates. Every navigation, click and
 * keystroke happens in the visible browser.
 *
 * Screens belong to Bots, not runs (see `lib/computer/screens.ts`), so a Bot's
 * next job finds its tabs and sign-ins where it left them.
 */


const preparedDirectories = sessionState<true>();

/**
 * Each run works in its own tab of the team's one browser, so two Bots never
 * fight over the same page. The tab belongs to the run's agent-browser session
 * and is labelled with it, so a later action finds it and the console can show
 * this Bot its own tab. The session name is the run's, kept to characters
 * agent-browser accepts.
 */
const runSessionName = (ctx: ToolContext) => `run-${ctx.session.id.replace(/[^A-Za-z0-9_-]/g, "")}`.slice(0, 60);

/** Runs opened with their tab ready, so the label lookup happens once per run. */
/**
 * agent-browser's eve types describe eve 0.58's tool context, whose sandbox
 * carried an `id`. It only names its own sessions by it, and every call here
 * passes the run's session name, so eve 0.79's context serves as is.
 */
const pluginContext = (ctx: ToolContext) => ctx as unknown as Parameters<typeof runAgentBrowser>[0];

const openedTabs = sessionState<{ targetId: string; at: number }>();
const TAB_TRUSTED_MS = 60_000;

/**
 * The run's tab: by its label, or else by the target id recorded when it opened.
 * agent-browser forgets labels when its background process restarts, while the
 * session stays pinned to the same tab, so the id is what finds it again then.
 */
async function labelledTab(
  ctx: ToolContext,
  cdp: number,
  session: string,
  label: string,
  knownTargetId?: string,
): Promise<string | null> {
  try {
    const listed = await runAgentBrowser<{ data?: { tabs?: { label?: string | null; targetId?: string }[] } }>(
      pluginContext(ctx),
      ["--cdp", String(cdp), "tab", "list", "--json"],
      { session, env: await environment(await sessionDirectory(ctx)), abortSignal: ctx.abortSignal },
    );
    const tabs = listed.json?.data?.tabs ?? [];
    const tab =
      tabs.find((entry) => entry.label === label) ??
      (knownTargetId === undefined ? undefined : tabs.find((entry) => entry.targetId === knownTargetId));
    return tab?.targetId ?? null;
  } catch {
    return null;
  }
}

/**
 * The run's own tab, opening it the first time. Records it so the console can
 * show this Bot its own screen and, on takeover, bring the right tab to front.
 */
async function ensureRunTab(ctx: ToolContext, binding: SessionBinding, n: number): Promise<string | null> {
  const cached = openedTabs.get(ctx.session.id);
  if (cached !== undefined && Date.now() - cached.at < TAB_TRUSTED_MS) return cached.targetId;

  const cdp = screenPorts(n).cdp;
  const session = runSessionName(ctx);
  const label = binding.tabLabel ?? session;

  let targetId = await labelledTab(ctx, cdp, session, label, binding.targetId);
  if (targetId === null) {
    try {
      const opened = await runAgentBrowser<{ data?: { targetId?: string } }>(
        pluginContext(ctx),
        ["--cdp", String(cdp), "--pin-tab", "tab", "new", "--label", label, "about:blank"],
        { session, env: await environment(await sessionDirectory(ctx)), abortSignal: ctx.abortSignal },
      );
      // `tab new` answers with the new tab's target id; list the tabs only if it did not.
      targetId = opened.json?.data?.targetId ?? (await labelledTab(ctx, cdp, session, label));
    } catch {
      // The action that follows still runs; without a labelled tab it lands on the pinned one.
    }
  }
  if (targetId === null) return null;

  openedTabs.set(ctx.session.id, { targetId, at: Date.now() });
  const { workspaceId } = operator(ctx);
  await setBotTab(workspaceId, binding.botId, { targetId, sessionId: ctx.session.id, at: new Date().toISOString() });
  await noteRunTab(workspaceId, targetId, { n, sessionId: ctx.session.id, jobId: binding.jobId, at: new Date().toISOString() }).catch(() => undefined);
  // A new tab is a good moment to close the tabs of jobs that are over; bounded, and never the reason a step fails.
  await within(
    (async () => closeFinishedTabs(workspaceId, await toolHands(ctx), targetId))(),
    10_000,
  ).catch(() => 0);
  if (binding.targetId !== targetId || binding.tabLabel !== label) {
    await bindSession({ ...binding, targetId, tabLabel: label });
  }
  return targetId;
}

/** This run's scratch folder on the computer, created on first use. */
export async function sessionDirectory(ctx: ToolContext): Promise<string> {
  const directory = `${COMPUTER_PATHS.sessions}/${ctx.session.id}`;
  if (!preparedDirectories.has(directory)) {
    const sandbox = await ctx.getSandbox();
    const result = await sandbox.run({ command: `mkdir -p '${directory.replaceAll("'", "")}'` });
    if (result.exitCode === 0) preparedDirectories.set(directory, true);
  }
  return directory;
}

/** agent-browser's environment for a session, with the deployment's settings (see `settings/store.ts`). */
async function environment(directory: string): Promise<Record<string, string>> {
  const settings = await effectiveEnv();
  const env: Record<string, string> = {
    AGENT_BROWSER_MAX_OUTPUT: settings.BOT_BROWSER_MAX_OUTPUT?.trim() || "20000",
    // Page text is untrusted input; the markers let the model see where it starts.
    AGENT_BROWSER_CONTENT_BOUNDARIES: "1",
    AGENT_BROWSER_DOWNLOAD_PATH: COMPUTER_PATHS.downloads,
    AGENT_BROWSER_SCREENSHOT_DIR: directory,
  };
  if (settings.BOT_BROWSER_ALLOWED_DOMAINS?.trim()) {
    env.AGENT_BROWSER_ALLOWED_DOMAINS = settings.BOT_BROWSER_ALLOWED_DOMAINS.trim();
  }
  return env;
}

/**
 * Whether the CLI that printed `versionOutput` ("agent-browser 0.39.1") is older
 * than the one this app speaks. Output that names no version is not "older":
 * a missing CLI is installed by the missing-binary path instead.
 */
export function cliOutdated(versionOutput: string, wanted: string = AGENT_BROWSER_SANDBOX_VERSION): boolean {
  const parse = (text: string) => /(\d+)\.(\d+)\.(\d+)/.exec(text)?.slice(1, 4).map(Number) ?? null;
  const have = parse(versionOutput);
  const want = parse(wanted);
  if (have === null || want === null) return false;
  for (let i = 0; i < 3; i += 1) {
    if (have[i] !== want[i]) return have[i]! < want[i]!;
  }
  return false;
}

/**
 * A computer keeps the CLI it was built with until it is replaced, and the
 * tools here use commands newer ones added (`batch`, `webmcp`, `record`). So
 * the first browser action in this process checks the version once and
 * installs this app's when the computer's is older.
 */
let cliChecked: Promise<void> | null = null;
/** After a failed check or install, when to try again: not on every action, since an install takes a while. */
let cliRetryAt = 0;
const CLI_RETRY_MS = 10 * 60_000;
async function currentCli(ctx: ToolContext): Promise<void> {
  if (cliChecked === null && Date.now() < cliRetryAt) return;
  cliChecked ??= (async () => {
    const sandbox = await ctx.getSandbox();
    const found = await sandbox.run({ command: "agent-browser --version" });
    if (found.exitCode !== 0 || !cliOutdated(found.stdout)) return;
    console.log(`[browser] moving the computer from ${found.stdout.trim()} to agent-browser ${AGENT_BROWSER_SANDBOX_VERSION}`);
    await installAgentBrowser(sandbox as never, AGENT_BROWSER_INSTALL);
  })().catch((error: unknown) => {
    // Tried again in a while; the old CLI still serves what it knows meanwhile.
    cliChecked = null;
    cliRetryAt = Date.now() + CLI_RETRY_MS;
    console.warn("[browser] could not check agent-browser's version:", error instanceof Error ? error.message : error);
  });
  await cliChecked;
}

function missingBinary(error: unknown): boolean {
  if (!(error instanceof AgentBrowserCommandError)) return false;
  return error.exitCode === 127 || /not found|no such file/i.test(error.stderr);
}

/**
 * What a failed command said about why. A batch prints every command's result,
 * page text included, so only its commands' errors count: a page that mentions
 * "CDP" is not a browser that went away.
 */
function failureText(error: AgentBrowserCommandError): string {
  const steps = batchSteps(parseJson(error.stdout));
  return steps === null ? `${error.stderr}\n${error.stdout}` : [error.stderr, ...steps.map((step) => step.error ?? "")].join("\n");
}

function browserGone(error: unknown): boolean {
  if (!(error instanceof AgentBrowserCommandError)) return false;
  return /CDP|connection refused|os error 111|target closed|browser has disconnected/i.test(failureText(error));
}

/** The run's pinned tab was closed under it; agent-browser refuses to act on another tab instead. */
function tabGone(error: unknown): boolean {
  if (!(error instanceof AgentBrowserCommandError)) return false;
  return /tab_gone/.test(failureText(error));
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

interface BatchStep {
  readonly success: boolean;
  readonly result: unknown;
  readonly error: string | null;
}

/** The array `batch --json` prints, one entry per command; null for anything else. */
function batchSteps(json: unknown): BatchStep[] | null {
  if (!Array.isArray(json)) return null;
  if (!json.every((entry) => entry !== null && typeof entry === "object" && typeof (entry as { success?: unknown }).success === "boolean")) return null;
  return json.map((entry: { success: boolean; result?: unknown; error?: unknown }) => ({
    success: entry.success,
    result: entry.result ?? null,
    error: typeof entry.error === "string" ? entry.error : null,
  }));
}

/** A batch command's words, which agent-browser splits the way a shell would; kept to words that need no quoting. */
const PLAIN_WORD = /^[A-Za-z0-9@#._:=/,-]+$/;

/**
 * One result per command of a batch, each shaped like `browser`'s own (its
 * `data` is the `{ success, data, error }` envelope a lone command prints), so
 * `payload` and `textOf` read them the same way. Pure, for tests.
 */
export function batchResults(result: BrowserResult, count: number): BrowserResult[] {
  const steps = batchSteps(result.data);
  if (steps === null) {
    // The batch did not run: the screen, the tab or the CLI failed first.
    const error = result.ok ? "The browser's answer was not a batch." : (result.error ?? "The browser did not answer.");
    return Array.from({ length: count }, (): BrowserResult => ({ ok: false, output: result.output, data: null, error }));
  }
  return Array.from({ length: count }, (_, i): BrowserResult => {
    const step = steps[i];
    if (step === undefined) return { ok: false, output: "", data: null, error: "The browser did not run this step." };
    const envelope = { success: step.success, data: step.result, error: step.error };
    return step.success ? { ok: true, output: "", data: envelope } : { ok: false, output: step.error ?? "", data: envelope, error: step.error ?? "The step failed." };
  });
}

/**
 * Several commands in one call to the computer (agent-browser's `batch`),
 * each run whatever happened to the one before: one round trip instead of one
 * per command. For commands this module writes itself, never the model's.
 */
export async function browserBatch(ctx: ToolContext, commands: readonly (readonly string[])[]): Promise<BrowserResult[]> {
  for (const command of commands) {
    if (!command.every((word) => PLAIN_WORD.test(word))) throw new Error(`Batch commands take plain words only: ${command.join(" ")}`);
  }
  const result = await browser(ctx, ["batch", ...commands.map((command) => command.join(" "))]);
  return batchResults(result, commands.length);
}

export interface BrowserResult {
  readonly ok: boolean;
  readonly output: string;
  readonly data: unknown;
  readonly error?: string;
  /** With `guard`: what the network guard stopped the action from sending (see `netguard.ts`). */
  readonly stopped?: readonly Stopped[];
  /** With `guard`: why the action could not be watched. When it was not run at all, `ok` is false. */
  readonly unwatched?: string;
}

/** agent-browser commands that would take the browser away from the operator too. */
const FORBIDDEN = new Set(["close", "quit", "exit", "connect", "install"]);

/** How long a run trusts that its screen is up before asking the computer again. */
const SCREEN_TRUSTED_MS = 30_000;
const readyScreens = sessionState<{ n: number; at: number }>();

/**
 * Binds this run to the team's screen, allocating one if the workspace has
 * none. Called by `job_brief`; starting the screen is left to the first
 * browser action.
 */
export async function bindScreen(ctx: ToolContext, botId: string, jobId: string): Promise<SessionBinding> {
  const { workspaceId } = operator(ctx);
  const screen = await allocateScreen(workspaceId, botId);
  return bindSession({ sessionId: ctx.session.id, workspaceId, botId, jobId, n: screen.n });
}

/** The team's screen, following it if the workspace was moved to another one meanwhile. */
async function currentScreen(ctx: ToolContext, binding: SessionBinding) {
  const screen = await teamScreen(binding.workspaceId);
  if (screen !== null) {
    if (screen.n !== binding.n) {
      await bindSession({ ...binding, n: screen.n });
      readyScreens.delete(ctx.session.id);
    }
    return screen;
  }
  const allocated = await allocateScreen(binding.workspaceId, binding.botId);
  await bindSession({ ...binding, n: allocated.n });
  readyScreens.delete(ctx.session.id);
  return allocated;
}

async function readyScreen(ctx: ToolContext, n: number, recorded: ServiceState): Promise<void> {
  const ready = readyScreens.get(ctx.session.id);
  if (ready !== undefined && ready.n === n && Date.now() - ready.at < SCREEN_TRUSTED_MS) return;
  const hands = await toolHands(ctx);
  try {
    if (recorded !== "on") await setBrowserState(n, "starting");
    const started = await hands.screen.ensure(n);
    // Someone may have left the file manager or a terminal over the browser.
    await hands.browser.raise(n).catch(() => undefined);
    if (started.started || recorded !== "on") await setBrowserState(n, "on");
    await touchScreen(n);
    readyScreens.set(ctx.session.id, { n, at: Date.now() });
  } catch (error) {
    await setBrowserState(n, "error", error instanceof Error ? error.message : String(error));
    throw error;
  }
}

/**
 * Runs one agent-browser command in the Bot's visible browser, starting the
 * screen and installing agent-browser on first use.
 *
 * Failures come back as data rather than exceptions: a click that missed is
 * information the model should act on, not a tool crash.
 *
 * With `guard`, the action runs with the network guard armed on the run's tab
 * (`netguard.ts`), and the result says what the guard stopped it from sending.
 * An action that cannot be watched is not run (`unwatched`), and a guarded
 * action is not retried here: a retry might land on another tab.
 */
/** Browser commands whose failure is routine (a wait that timed out, a read of nothing) and not worth a journal line. */
const QUIET_FAILURES = new Set(["wait", "get", "eval", "snapshot", "screenshot", "focus", "batch"]);

export async function browser(ctx: ToolContext, args: readonly string[], options: { readonly guard?: boolean } = {}): Promise<BrowserResult> {
  const result = await browserCommand(ctx, args, options);
  if (!result.ok && !QUIET_FAILURES.has(args[0] ?? "")) {
    const why = (result.error ?? result.output).replace(/\s+/g, " ").trim().slice(0, 160);
    await journal(ctx, { kind: "error", text: `${args[0] ?? "browser"} failed: ${why}`, data: { tool: `browser ${args[0] ?? ""}`.trim() } });
  }
  return result;
}

async function browserCommand(ctx: ToolContext, args: readonly string[], options: { readonly guard?: boolean } = {}): Promise<BrowserResult> {
  const missing = lacking(currentKind(), "browser");
  if (missing !== null) return failure(new Error(missing));
  if (FORBIDDEN.has(args[0] ?? "")) {
    return failure(new Error(`"${args[0]}" is not available: the browser stays open so the team can see and use it.`));
  }
  const { workspaceId } = operator(ctx);
  const binding = await sessionBinding(workspaceId, ctx.session.id);
  if (binding === null) {
    return failure(new Error("Call job_brief first: it sets up your screen on the team's computer."));
  }

  let n: number;
  let recorded: ServiceState;
  let tab: string | null;
  try {
    const screen = await currentScreen(ctx, binding);
    const control = liveControl(screen);
    if (control !== null) {
      return failure(
        new Error(
          "A person has control of your browser right now (for example to sign in). Wait for them to hand it back — call request_takeover if you have not — and do not act on the page meanwhile.",
        ),
      );
    }
    n = screen.n;
    recorded = screen.browser.state;
    await readyScreen(ctx, n, recorded);
    await currentCli(ctx);
    // Open this run's own tab before its first action, so two Bots never share one page.
    tab = await ensureRunTab(ctx, binding, n);
  } catch (error) {
    return failure(error);
  }

  const session = runSessionName(ctx);
  const inTab = async (command: readonly string[]) =>
    runAgentBrowser(pluginContext(ctx), ["--cdp", String(screenPorts(n).cdp), "--pin-tab", ...command], {
      abortSignal: ctx.abortSignal,
      env: await environment(await sessionDirectory(ctx)),
      // One agent-browser session per run, pinned to that run's own tab in the shared browser.
      session,
    });
  const run = () => inTab(args);

  // A video of the job's browser work, when it is on; never the reason an action fails.
  if (args[0] !== "record") {
    const recorder = async (command: readonly string[]) => {
      try {
        return shape(await inTab(command));
      } catch (error) {
        return failure(error);
      }
    };
    await within(
      (async () => keepRecording(ctx, recorder, await sessionDirectory(ctx)))(),
      25_000,
    ).catch(() => undefined);
  }

  if (options.guard === true) return guarded(ctx, screenPorts(n).cdp, tab, run);

  try {
    return shape(await run());
  } catch (error) {
    try {
      if (missingBinary(error)) {
        await installAgentBrowser((await ctx.getSandbox()) as never, { ...AGENT_BROWSER_INSTALL, abortSignal: ctx.abortSignal });
        return shape(await run());
      }
      if (tabGone(error)) {
        // Someone closed this run's tab, for example during a takeover: open a fresh one and try once more.
        openedTabs.delete(ctx.session.id);
        await ensureRunTab(ctx, binding, n);
        return shape(await run());
      }
      if (browserGone(error)) {
        // The browser was closed or crashed; bring it back once.
        readyScreens.delete(ctx.session.id);
        await readyScreen(ctx, n, "off");
        return shape(await run());
      }
    } catch (retryError) {
      return failure(retryError);
    }
    return failure(error);
  }
}

/** One action with the network guard armed on the run's tab; see `browser`. */
async function guarded(
  ctx: ToolContext,
  cdp: number,
  tab: string | null,
  run: () => Promise<{ json: unknown; stdout: string; stderr: string }>,
): Promise<BrowserResult> {
  const unwatched = (reason: string): BrowserResult => ({
    ok: false,
    output: "",
    data: null,
    error: `This was not done: what it would send could not be watched (${reason}).`,
    unwatched: reason,
  });
  if (tab === null) return unwatched("this run's tab could not be found");
  const io = (await toolHands(ctx)).shell;
  const program = shellQuote(`${COMPUTER_BIN}/${NETGUARD_FILE}`);
  const armed = parseGuardAnswer<{ id: string }>(
    (await io.run(`node ${program} arm ${cdp} ${shellQuote(tab)} ${GUARD_TTL_MS}`, { timeoutMs: 20_000 }).catch((error: unknown) => ({ stdout: JSON.stringify({ ok: false, error: String(error) }) }))).stdout,
  );
  if (!armed.ok) return unwatched(armed.error);

  let result: BrowserResult;
  try {
    result = shape(await run());
  } catch (error) {
    result = failure(error);
  }
  const report = parseGuardAnswer<{ blocked: Stopped[] }>(
    (await io.run(`node ${program} disarm ${shellQuote(armed.id)} ${guardGraceMs(await effectiveEnv())}`, { timeoutMs: 20_000 }).catch((error: unknown) => ({ stdout: JSON.stringify({ ok: false, error: String(error) }) }))).stdout,
  );
  return report.ok ? { ...result, stopped: report.blocked } : { ...result, unwatched: report.error };
}

const POSTER_EVERY_MS = 5_000;
const lastPoster = sessionState<number>();

/**
 * Refreshes the still frame the console shows for the team's screen when nobody
 * is watching live. Throttled and best-effort: the frame goes to storage for the
 * console, never into the model's context, and a missed frame never fails the
 * action that triggered it.
 */
export async function refreshScreen(ctx: ToolContext): Promise<void> {
  const now = Date.now();
  if (now - (lastPoster.get(ctx.session.id) ?? 0) < POSTER_EVERY_MS) return;
  lastPoster.set(ctx.session.id, now);
  try {
    const { workspaceId } = operator(ctx);
    const binding = await sessionBinding(workspaceId, ctx.session.id);
    if (binding === null) return;
    // This Bot's own tab, so its thumbnail shows its work even while another Bot's tab is on screen.
    const shot = await (await toolHands(ctx)).screen.capture(binding.n, 55, binding.targetId);
    if (await saveScreen(workspaceId, posterKey(binding.botId), shot.bytes, shot.mediaType)) {
      await setPosterAt(binding.n, new Date().toISOString(), binding.botId);
    }
  } catch {
    // The console keeps showing the previous frame.
  }
}

/**
 * The `data` of agent-browser's JSON envelope, `{ success, data, error }`.
 *
 * `runAgentBrowser` passes `--json` to every command, so `output` is that
 * envelope rather than the plain text the CLI prints by hand. Null when the
 * command printed something else, so callers fall back to `output`.
 */
export function payload(result: Pick<BrowserResult, "data">): Record<string, unknown> | null {
  const envelope = result.data as { data?: unknown } | null;
  const data = envelope?.data;
  return data !== null && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
}

/** One string field of the envelope's data, or the plain output when there is no envelope. */
export function textOf(result: BrowserResult, field: string): string {
  const value = payload(result)?.[field];
  if (typeof value === "string") return value;
  return payload(result) === null ? result.output : "";
}

function shape(result: { json: unknown; stdout: string; stderr: string }): BrowserResult {
  return {
    ok: true,
    output: (result.stdout || result.stderr).trim(),
    data: result.json,
  };
}

function failure(error: unknown): BrowserResult {
  if (error instanceof AgentBrowserCommandError) {
    return {
      ok: false,
      output: (error.stderr || error.stdout).trim().slice(0, 4_000),
      // A batch exits 1 when one of its commands failed, and still prints them all (see `batchResults`).
      data: batchSteps(parseJson(error.stdout)) === null ? null : parseJson(error.stdout),
      error: `agent-browser exited ${error.exitCode}`,
    };
  }
  if (error instanceof ComputerError) {
    return { ok: false, output: "", data: null, error: `The computer could not start your browser: ${error.message}` };
  }
  return {
    ok: false,
    output: "",
    data: null,
    error: error instanceof Error ? error.message : String(error),
  };
}
