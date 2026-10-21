/**
 * The Claude Code engine's settings: one durable-harness agent for the whole
 * deployment, made from these options in two places that must agree:
 *
 * - the queue route `withDurableHarness` writes into the Next.js app, which
 *   drives sessions (`src/lib/engines/claude-code-agent.ts`), and
 * - `run_job`'s steps on the agent service, which start, watch and stop
 *   them (`./sessions`).
 *
 * Nothing here imports durable-harness at run time: a deployment with
 * engines off never loads it, and its build never carries it. What every
 * session gets is in `./harness-options`.
 *
 * The model is `BOT_CLAUDE_CODE_MODEL` if set, else the library's default
 * (`claude-sonnet-4-5` in H0). One agent holds one model (plan section 4.6).
 */
import type { ClaudeCodeOptions } from "durable-harness/claude-code";
import type { SandboxOptions, SandboxWorkspace } from "durable-harness/sandbox";
import type { HostTool } from "durable-harness/tools";

import { HARNESS_INSTRUCTIONS, harnessSandbox } from "./harness-options";
import { HOST_TOOLS } from "./host-tools";

/** The agent's kernel name: its sessions' runs are named after it, so it must never change. */
export const CLAUDE_CODE_AGENT_NAME = "eve-bot-claude-code";

/** The Sandbox every session gets (kept under this name for the tests and the docs). */
export const claudeCodeSandbox = harnessSandbox;

/** The agent's options, given durable-harness's `sandbox()` (so this module never loads the package). */
export function claudeCodeOptions(
  sandbox: (options: SandboxOptions) => SandboxWorkspace,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ClaudeCodeOptions {
  const model = env.BOT_CLAUDE_CODE_MODEL?.trim();
  return {
    name: CLAUDE_CODE_AGENT_NAME,
    ...(model ? { model } : {}),
    instructions: HARNESS_INSTRUCTIONS,
    tools: HOST_TOOLS as unknown as HostTool[],
    builtins: false,
    workspace: sandbox(harnessSandbox(env)),
  };
}
