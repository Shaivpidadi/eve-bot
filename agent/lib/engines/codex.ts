/**
 * The Codex engine's settings, as `./claude-code` is for Claude Code: one
 * durable-harness agent, made in the Next.js app's queue route
 * (`src/lib/engines/codex-agent.ts`) and in `run_job`'s steps (`./sessions`)
 * from these same options.
 *
 * Codex needs an AI Gateway model that speaks OpenAI's Responses API:
 * `BOT_CODEX_MODEL`, else `openai/gpt-5.4-mini` (the model its H4 spike ran
 * on). Its CLI is the build pinned in the Sandbox's image; nothing extra is
 * installed for it.
 */
// First: the build's Settings values over the environment, before anything below reads it (see settings/built.ts).
import "../settings/built";
import type { CodexOptions } from "durable-harness/codex";
import type { SandboxOptions, SandboxWorkspace } from "durable-harness/sandbox";
import type { HostTool } from "durable-harness/tools";

import { harnessBuiltins, harnessInstructions, harnessSandbox } from "./harness-options";
import { HOST_TOOLS } from "./host-tools";

/** The agent's kernel name: its sessions' runs are named after it, so it must never change. */
export const CODEX_AGENT_NAME = "eve-bot-codex";

export const DEFAULT_CODEX_MODEL = "openai/gpt-5.4-mini";

export function codexOptions(
  sandbox: (options: SandboxOptions) => SandboxWorkspace,
  env: Readonly<Record<string, string | undefined>> = process.env,
): CodexOptions {
  return {
    name: CODEX_AGENT_NAME,
    model: env.BOT_CODEX_MODEL?.trim() || DEFAULT_CODEX_MODEL,
    instructions: harnessInstructions(env),
    tools: HOST_TOOLS as unknown as HostTool[],
    builtins: harnessBuiltins(env),
    workspace: sandbox(harnessSandbox(env)),
  };
}
