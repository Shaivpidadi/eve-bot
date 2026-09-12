import {
  AgentBrowserCommandError,
  installAgentBrowser,
  runAgentBrowser,
} from "@agent-browser/eve/sandbox";
import type { ToolContext } from "eve/tools";

import { COMPUTER_PATHS } from "../../../lib/computer";
import { AGENT_BROWSER_INSTALL } from "../../../lib/computer-config";
import { captureScreen, ComputerError, ensureScreen, raiseBrowser, toolIo } from "../../../lib/computer/runtime";
import {
  allocateScreen,
  bindSession,
  liveControl,
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

const MAX_OUTPUT = process.env.BOT_BROWSER_MAX_OUTPUT ?? "20000";

const preparedDirectories = new Set<string>();

/**
 * Each run works in its own tab of the team's one browser, so two Bots never
 * fight over the same page. The tab belongs to the run's agent-browser session
 * and is labelled with it, so a later action finds it and the console can show
 * this Bot its own tab. The session name is the run's, kept to characters
 * agent-browser accepts.
 */
const runSessionName = (ctx: ToolContext) => `run-${ctx.session.id.replace(/[^A-Za-z0-9_-]/g, "")}`.slice(0, 60);

/** Runs opened with their tab ready, so the label lookup happens once per run. */
const openedTabs = new Map<string, { targetId: string; at: number }>();
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
      ctx,
      ["--cdp", String(cdp), "tab", "list", "--json"],
      { session, env: environment(await sessionDirectory(ctx)), abortSignal: ctx.abortSignal },
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
        ctx,
        ["--cdp", String(cdp), "--pin-tab", "tab", "new", "--label", label, "about:blank"],
        { session, env: environment(await sessionDirectory(ctx)), abortSignal: ctx.abortSignal },
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
    if (result.exitCode === 0) preparedDirectories.add(directory);
  }
  return directory;
}

function environment(directory: string): Record<string, string> {
  const env: Record<string, string> = {
    AGENT_BROWSER_MAX_OUTPUT: MAX_OUTPUT,
    // Page text is untrusted input; the markers let the model see where it starts.
    AGENT_BROWSER_CONTENT_BOUNDARIES: "1",
    AGENT_BROWSER_DOWNLOAD_PATH: COMPUTER_PATHS.downloads,
    AGENT_BROWSER_SCREENSHOT_DIR: directory,
  };
  if (process.env.BOT_BROWSER_ALLOWED_DOMAINS) {
    env.AGENT_BROWSER_ALLOWED_DOMAINS = process.env.BOT_BROWSER_ALLOWED_DOMAINS;
  }
  return env;
}

function missingBinary(error: unknown): boolean {
  if (!(error instanceof AgentBrowserCommandError)) return false;
  return error.exitCode === 127 || /not found|no such file/i.test(error.stderr);
}

function browserGone(error: unknown): boolean {
  if (!(error instanceof AgentBrowserCommandError)) return false;
  return /CDP|connection refused|os error 111|target closed|browser has disconnected/i.test(`${error.stderr}\n${error.stdout}`);
}

/** The run's pinned tab was closed under it; agent-browser refuses to act on another tab instead. */
function tabGone(error: unknown): boolean {
  if (!(error instanceof AgentBrowserCommandError)) return false;
  return /tab_gone/.test(`${error.stderr}\n${error.stdout}`);
}

export interface BrowserResult {
  readonly ok: boolean;
  readonly output: string;
  readonly data: unknown;
  readonly error?: string;
}

/** agent-browser commands that would take the browser away from the operator too. */
const FORBIDDEN = new Set(["close", "quit", "exit", "connect", "install"]);

/** How long a run trusts that its screen is up before asking the computer again. */
const SCREEN_TRUSTED_MS = 30_000;
const readyScreens = new Map<string, { n: number; at: number }>();

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
  const io = await toolIo(ctx);
  try {
    if (recorded !== "on") await setBrowserState(n, "starting");
    const started = await ensureScreen(io, n);
    // Someone may have left the file manager or a terminal over the browser.
    await raiseBrowser(io, n).catch(() => undefined);
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
 */
export async function browser(ctx: ToolContext, args: readonly string[]): Promise<BrowserResult> {
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
    // Open this run's own tab before its first action, so two Bots never share one page.
    await ensureRunTab(ctx, binding, n);
  } catch (error) {
    return failure(error);
  }

  const session = runSessionName(ctx);
  const run = async () =>
    runAgentBrowser(ctx, ["--cdp", String(screenPorts(n).cdp), "--pin-tab", ...args], {
      abortSignal: ctx.abortSignal,
      env: environment(await sessionDirectory(ctx)),
      // One agent-browser session per run, pinned to that run's own tab in the shared browser.
      session,
    });

  try {
    return shape(await run());
  } catch (error) {
    try {
      if (missingBinary(error)) {
        await installAgentBrowser(await ctx.getSandbox(), { ...AGENT_BROWSER_INSTALL, abortSignal: ctx.abortSignal });
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

const POSTER_EVERY_MS = 5_000;
const lastPoster = new Map<string, number>();

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
    const shot = await captureScreen(await toolIo(ctx), binding.n, 55, binding.targetId);
    if (await saveScreen(workspaceId, posterKey(binding.botId), shot.bytes, shot.mediaType)) {
      await setPosterAt(binding.n, new Date().toISOString(), binding.botId);
    }
  } catch {
    // The console keeps showing the previous frame.
  }
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
      data: null,
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
