/**
 * What every harness engine's sessions get, whichever CLI runs them (plan
 * sections 4.3 to 4.5): the eve-bot tools, a Sandbox with no network, a spend
 * cap per turn and per session at the job's limit, and a short idle time.
 * `./claude-code` and `./codex` build their agents from it.
 *
 * The CLI's own tools (a shell and file editing, on the session's Drive in its
 * VM) are off unless the owner turns them on with `BOT_ENGINE_BUILTINS=1`; the
 * VM's network stays shut unless `BOT_ENGINE_NETWORK` opens it. Both are read
 * where the agent is made, so they hold for the whole deployment.
 *
 * Nothing here imports durable-harness at run time.
 */
import type { SandboxNetwork, SandboxOptions } from "durable-harness/sandbox";

type Env = Readonly<Record<string, string | undefined>>;

/** How long a session's VM stays up after a turn. Short: a job's turns are minutes apart at most. */
const IDLE_MS = 60_000;

/** Whether the CLI's own tools are on: `BOT_ENGINE_BUILTINS=1`, never by default. */
export function harnessBuiltins(env: Env = process.env): boolean {
  return env.BOT_ENGINE_BUILTINS?.trim() === "1";
}

/**
 * The VM's outbound network: `BOT_ENGINE_NETWORK` unset is none at all (DNS
 * included), `allow-all` is everything, and a comma list of domains
 * (`*.example.com` for subdomains) is only those.
 */
export function harnessNetwork(env: Env = process.env): SandboxNetwork {
  const value = env.BOT_ENGINE_NETWORK?.trim() ?? "";
  if (value === "" || value === "deny-all") return "deny-all";
  if (value === "allow-all") return "allow-all";
  const allow = value
    .split(",")
    .map((domain) => domain.trim().toLowerCase())
    .filter((domain) => /^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain));
  return allow.length > 0 ? { allow } : "deny-all";
}

const describeNetwork = (network: SandboxNetwork): string =>
  network === "deny-all" ? "no network" : network === "allow-all" ? "an open network" : `network to ${network.allow.join(", ")} only`;

export function harnessInstructions(env: Env = process.env): string {
  const builtins = harnessBuiltins(env);
  return [
    "You are a Bot on a team, doing one job.",
    builtins
      ? `Besides job_brief, log_progress, finish_job and send_email you have a shell and file tools in /workspace, a scratch space of this job's own, with ${describeNetwork(harnessNetwork(env))}. Nothing in it outlives the job: put what matters in finish_job's result.`
      : "Your only tools are job_brief, log_progress, finish_job and send_email. You have no shell, no files and no network.",
    "send_email only asks a person: they approve or decline, and eve-bot sends it. Ask once per email.",
    "Call job_brief first. Log each meaningful step with log_progress.",
    "End with finish_job, once, with an honest result, then end your turn.",
  ].join("\n");
}

/** The instructions with everything off, as a deployment without the opt-ins has them. */
export const HARNESS_INSTRUCTIONS = harnessInstructions({});

/** The Sandbox every session gets: the network above, the job's spend limit, and a short idle. */
export function harnessSandbox(env: Env = process.env): SandboxOptions {
  const cap = Number(env.BOT_JOB_COST_LIMIT_USD ?? 5);
  return {
    network: harnessNetwork(env),
    idleMs: IDLE_MS,
    ...(Number.isFinite(cap) && cap > 0 ? { budget: { turnUsd: cap, sessionUsd: cap } } : {}),
  };
}
