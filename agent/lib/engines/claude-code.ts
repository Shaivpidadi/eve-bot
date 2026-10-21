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
 * engines off never loads it, and its build never carries it.
 *
 * What a session gets (plan sections 4.3 to 4.5):
 * - no built-ins: the eve-bot tools in `./host-tools` are its only tools,
 *   so nothing it does reaches the outside world except through them;
 * - a Sandbox with no network at all (`deny-all`); model calls still work,
 *   because the Function makes them, adding the Gateway credential there;
 * - a spend cap per turn and per session at the job's limit
 *   (`BOT_JOB_COST_LIMIT_USD`, read at build like the teammate's own cap),
 *   since the library has none by default;
 * - a short idle time, so a finished job does not keep its VM up.
 *
 * The model is `BOT_CLAUDE_CODE_MODEL` if set, else the library's default.
 * One agent holds one model (plan section 4.6).
 */
import type { ClaudeCodeOptions } from "durable-harness/claude-code";
import type { SandboxOptions, SandboxWorkspace } from "durable-harness/sandbox";
import type { HostTool } from "durable-harness/tools";

import { HOST_TOOLS } from "./host-tools";

/** The agent's kernel name: its sessions' runs are named after it, so it must never change. */
export const CLAUDE_CODE_AGENT_NAME = "eve-bot-claude-code";

/** How long a session's VM stays up after a turn. Short: a job's turns are minutes apart at most. */
const IDLE_MS = 60_000;

const INSTRUCTIONS = [
  "You are a Bot on a team, doing one job.",
  "Your only tools are job_brief, log_progress and finish_job. You have no shell, no files and no network.",
  "Call job_brief first. Log each meaningful step with log_progress.",
  "End with finish_job, once, with an honest result, then end your turn.",
].join("\n");

/** The Sandbox every session gets. */
export function claudeCodeSandbox(env: Readonly<Record<string, string | undefined>> = process.env): SandboxOptions {
  const cap = Number(env.BOT_JOB_COST_LIMIT_USD ?? 5);
  return {
    network: "deny-all",
    idleMs: IDLE_MS,
    ...(Number.isFinite(cap) && cap > 0 ? { budget: { turnUsd: cap, sessionUsd: cap } } : {}),
  };
}

/** The agent's options, given durable-harness's `sandbox()` (so this module never loads the package). */
export function claudeCodeOptions(
  sandbox: (options: SandboxOptions) => SandboxWorkspace,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ClaudeCodeOptions {
  const model = env.BOT_CLAUDE_CODE_MODEL?.trim();
  return {
    name: CLAUDE_CODE_AGENT_NAME,
    ...(model ? { model } : {}),
    instructions: INSTRUCTIONS,
    tools: HOST_TOOLS as unknown as HostTool[],
    builtins: false,
    workspace: sandbox(claudeCodeSandbox(env)),
  };
}
