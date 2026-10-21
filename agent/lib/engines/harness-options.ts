/**
 * What every harness engine's sessions get, whichever CLI runs them (plan
 * sections 4.3 to 4.5): the eve-bot tools as their only tools, a Sandbox with
 * no network, a spend cap per turn and per session at the job's limit, and a
 * short idle time. `./claude-code` and `./codex` build their agents from it.
 *
 * Nothing here imports durable-harness at run time.
 */
import type { SandboxOptions } from "durable-harness/sandbox";

/** How long a session's VM stays up after a turn. Short: a job's turns are minutes apart at most. */
const IDLE_MS = 60_000;

export const HARNESS_INSTRUCTIONS = [
  "You are a Bot on a team, doing one job.",
  "Your only tools are job_brief, log_progress, finish_job and send_email. You have no shell, no files and no network.",
  "send_email only asks a person: they approve or decline, and eve-bot sends it. Ask once per email.",
  "Call job_brief first. Log each meaningful step with log_progress.",
  "End with finish_job, once, with an honest result, then end your turn.",
].join("\n");

/** The Sandbox every session gets: no network, the job's spend limit, and a short idle. */
export function harnessSandbox(env: Readonly<Record<string, string | undefined>> = process.env): SandboxOptions {
  const cap = Number(env.BOT_JOB_COST_LIMIT_USD ?? 5);
  return {
    network: "deny-all",
    idleMs: IDLE_MS,
    ...(Number.isFinite(cap) && cap > 0 ? { budget: { turnUsd: cap, sessionUsd: cap } } : {}),
  };
}
