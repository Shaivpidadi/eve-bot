import {
  AgentBrowserCommandError,
  installAgentBrowser,
  runAgentBrowser,
} from "@agent-browser/eve/sandbox";
import type { ToolContext } from "eve/tools";

/**
 * The bot's browser, wired to Vercel's agent-browser inside the bot's sandbox.
 *
 * agent-browser drives a real Chromium and speaks in accessibility snapshots
 * with stable `@ref` handles, which is what makes a web app usable by a model:
 * it reads the page the way a screen reader does and acts on named elements
 * rather than pixel coordinates.
 *
 * The binary and Chromium install themselves into the sandbox the first time a
 * tool needs them. A warm sandbox template makes that a no-op.
 */

const MAX_OUTPUT = process.env.BOT_BROWSER_MAX_OUTPUT ?? "20000";

function environment(): Record<string, string> {
  const env: Record<string, string> = {
    AGENT_BROWSER_MAX_OUTPUT: MAX_OUTPUT,
    // Page text is untrusted input; the markers let the model see where it starts.
    AGENT_BROWSER_CONTENT_BOUNDARIES: "1",
    AGENT_BROWSER_DOWNLOAD_PATH: "/workspace/downloads",
    AGENT_BROWSER_SCREENSHOT_DIR: "/workspace/work",
  };
  if (process.env.BOT_BROWSER_ALLOWED_DOMAINS) {
    env.AGENT_BROWSER_ALLOWED_DOMAINS = process.env.BOT_BROWSER_ALLOWED_DOMAINS;
  }
  if (process.env.BOT_BROWSER_PROXY) {
    env.AGENT_BROWSER_PROXY = process.env.BOT_BROWSER_PROXY;
  }
  return env;
}

function missingBinary(error: unknown): boolean {
  if (!(error instanceof AgentBrowserCommandError)) return false;
  return error.exitCode === 127 || /not found|no such file/i.test(error.stderr);
}

export interface BrowserResult {
  readonly ok: boolean;
  readonly output: string;
  readonly data: unknown;
  readonly error?: string;
}

/**
 * Runs one agent-browser command, installing the browser on first use.
 *
 * Failures come back as data rather than exceptions: a click that missed is
 * information the model should act on, not a tool crash.
 */
export async function browser(
  ctx: ToolContext,
  args: readonly string[],
): Promise<BrowserResult> {
  const options = {
    abortSignal: ctx.abortSignal,
    env: environment(),
    sessionPrefix: "bot",
  };

  try {
    return shape(await runAgentBrowser(ctx, args, options));
  } catch (error) {
    if (missingBinary(error)) {
      const sandbox = await ctx.getSandbox();
      await installAgentBrowser(sandbox, { abortSignal: ctx.abortSignal });
      try {
        return shape(await runAgentBrowser(ctx, args, options));
      } catch (retryError) {
        return failure(retryError);
      }
    }
    return failure(error);
  }
}

function shape(result: {
  json: unknown;
  stdout: string;
  stderr: string;
}): BrowserResult {
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
  return {
    ok: false,
    output: "",
    data: null,
    error: error instanceof Error ? error.message : String(error),
  };
}
