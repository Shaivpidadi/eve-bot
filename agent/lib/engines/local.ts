import { createHash, randomBytes, randomUUID } from "node:crypto";

import type { ComputerIo } from "../computer/runtime";
import type { LocalEngine } from "./index";

/**
 * Claude Code or Codex on the owner's own plan, on a standalone server's
 * team computer (`claude-code-local`, `codex-local`).
 *
 * A job's run starts the CLI in the background on the team's computer, as the
 * unprivileged `bot` user and fenced off the team's browser exactly like a
 * Bot's own shell (`computer/shell.ts`), in the Bot's folder, signed in with
 * what the owner saved in Settings → Engines: a token from `claude setup-token`,
 * or Codex's `~/.codex/auth.json` after `codex login --device-auth` (or an API
 * key, for either). The CLI reaches eve-bot's tools (read the job, log a step,
 * record the result, email and connectors with their approval cards) through an
 * MCP endpoint on this server, `/bot/v1/engine/mcp`, with a secret made for the
 * run and forgotten when it stops.
 *
 * `run_job` looks at the run as it looks at a durable-harness session: each
 * look reads what the CLI wrote since the last one (its JSON event stream),
 * puts its words in the Bot's thread, and notices when it ended. A crash of
 * this server leaves the CLI running on the computer; the job's next run kills
 * whatever is left of the old one (they share the run's process group) and
 * starts again from the job's journal, as an eve job does.
 *
 * Nothing here imports durable-harness, and nothing runs on Vercel.
 */

type Env = Readonly<Record<string, string | undefined>>;

/** Where the CLIs and each run's files live on the computer: shared with the `bot` user, and never backed up. */
export const ENGINES_ROOT = "/workspace/.engines";

/** The CLI versions installed on the computer, pinned (the ones these flags were checked against). */
export const CLI_PACKAGES: Readonly<Record<LocalEngine, { readonly name: string; readonly version: string; readonly bin: string }>> = {
  "claude-code-local": { name: "@anthropic-ai/claude-code", version: "2.1.308", bin: "claude" },
  "codex-local": { name: "@openai/codex", version: "0.163.0", bin: "codex" },
};

/** The secret a run's MCP calls carry, kept only as its hash. */
export const runSecretHash = (secret: string): string => createHash("sha256").update(secret).digest("hex");

export const runSecretKey = (hash: string) => `engine-runs/${hash}.json`;

/** What the store keeps for a running local run: who its MCP calls act for. */
export interface LocalRunRecord {
  readonly workspaceId: string;
  readonly jobId: string;
  /** The run id the job's lease is bound to, as a durable-harness session id is. */
  readonly runId: string;
  readonly engine: LocalEngine;
  readonly at: string;
}

export const newRunId = (): string => `local_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
export const newRunSecret = (): string => randomBytes(32).toString("base64url");

/** The run's folder on the computer. */
export const runDir = (runId: string) => `${ENGINES_ROOT}/runs/${runId}`;

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/** The address the CLI, inside the computer's container, reaches this server's MCP endpoint by. */
export function toolsUrl(origin: string, env: Env): string {
  const pinned = env.BOT_ENGINE_TOOLS_URL?.trim();
  if (pinned) return pinned.replace(/\/+$/, "");
  // The container's own localhost is not this machine's: Docker Desktop, OrbStack and Colima reach the host this way.
  const url = new URL(origin);
  if (["localhost", "127.0.0.1", "[::1]", "0.0.0.0"].includes(url.hostname)) url.hostname = "host.docker.internal";
  return `${url.origin}/bot/v1/engine/mcp`;
}

/** The sign-in a run uses, from Settings → Engines, as the CLI's environment and any file it needs. */
export function signIn(engine: LocalEngine, env: Env): { readonly env: Record<string, string>; readonly files: Record<string, string>; readonly paid: boolean } | null {
  if (engine === "claude-code-local") {
    const token = env.BOT_LOCAL_CLAUDE_TOKEN?.trim();
    if (!token) return null;
    const baseUrl = env.BOT_LOCAL_CLAUDE_BASE_URL?.trim();
    // A plan's token from `claude setup-token`; an API key bills per token; another base URL (AI Gateway, say) takes its own key.
    if (baseUrl) return { env: { ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: token }, files: {}, paid: true };
    if (token.startsWith("sk-ant-api")) return { env: { ANTHROPIC_API_KEY: token }, files: {}, paid: true };
    return { env: { CLAUDE_CODE_OAUTH_TOKEN: token }, files: {}, paid: false };
  }
  const auth = env.BOT_LOCAL_CODEX_AUTH?.trim();
  const key = env.BOT_LOCAL_CODEX_API_KEY?.trim();
  if (auth) return { env: {}, files: { ".codex/auth.json": auth }, paid: false };
  const baseUrl = env.BOT_LOCAL_CODEX_BASE_URL?.trim();
  if (key) return { env: { BOT_CODEX_KEY: key, ...(baseUrl ? { BOT_CODEX_BASE_URL: baseUrl } : {}) }, files: {}, paid: true };
  return null;
}

/**
 * The shell command that installs the engine's CLI on the computer, once (a
 * second run finds it there). Runs as the computer's own user; the folder is
 * the `bot-team` group's, so the `bot` user can run what is installed.
 */
export function installCommand(engine: LocalEngine): string {
  const cli = CLI_PACKAGES[engine];
  const prefix = `${ENGINES_ROOT}/cli`;
  return [
    "set -e",
    `mkdir -p ${prefix} ${ENGINES_ROOT}/runs`,
    `if getent group bot-team >/dev/null 2>&1; then chgrp bot-team ${ENGINES_ROOT} ${ENGINES_ROOT}/runs ${prefix} 2>/dev/null || true; fi`,
    `chmod 2775 ${ENGINES_ROOT} ${prefix}; chmod 2770 ${ENGINES_ROOT}/runs`,
    `if [ ! -x ${prefix}/bin/${cli.bin} ] || ! ${prefix}/bin/${cli.bin} --version 2>/dev/null | grep -q ${quote(cli.version)}; then`,
    `  npm install -g --prefix ${prefix} --no-audit --no-fund ${quote(`${cli.name}@${cli.version}`)} >/tmp/bot-engine-install.log 2>&1 || { tail -20 /tmp/bot-engine-install.log; exit 1; }`,
    "fi",
    `chmod -R g+rX,o-rwx ${prefix}`,
    "echo installed",
  ].join("\n");
}

/** What the CLI is asked to do: the job's brief, the working agreement, and how its tools are reached. */
export interface LaunchPlan {
  readonly engine: LocalEngine;
  readonly runId: string;
  readonly workingDirectory: string;
  readonly brief: string;
  readonly instructions: string;
  readonly toolsUrl: string;
  readonly secret: string;
  readonly model: string | null;
  readonly builtins: boolean;
  readonly env: Readonly<Record<string, string>>;
}

/**
 * The command, run as the `bot` user, that starts the CLI in the background
 * and returns at once: its JSON events go to `events.jsonl`, its errors to
 * `stderr.log`, and its exit code to `exit` when it ends. The brief and the
 * instructions are written to the run's folder beforehand (`brief.md`,
 * `instructions.md`, and `prompt.md`, both together, for Codex), so nothing
 * long rides the command line. It works from the Bot's folder.
 */
export function launchCommand(plan: LaunchPlan): string {
  const dir = runDir(plan.runId);
  const bin = `${ENGINES_ROOT}/cli/bin/${CLI_PACKAGES[plan.engine].bin}`;
  let cli: string;
  if (plan.engine === "claude-code-local") {
    // The run's secret stays in the environment; Claude Code expands it into the header.
    const mcp = JSON.stringify({ mcpServers: { bot: { type: "http", url: plan.toolsUrl, headers: { Authorization: "Bearer ${BOT_RUN_SECRET}" } } } });
    const allowed = ["mcp__bot__*", ...(plan.builtins ? ["Bash", "Read", "Edit", "Write", "Glob", "Grep"] : [])];
    const refused = plan.builtins ? ["WebFetch", "WebSearch", "Task", "NotebookEdit"] : ["Bash", "Read", "Edit", "Write", "Glob", "Grep", "WebFetch", "WebSearch", "Task", "NotebookEdit"];
    cli = [
      bin,
      "-p",
      `"$(cat ${dir}/brief.md)"`,
      "--append-system-prompt",
      `"$(cat ${dir}/instructions.md)"`,
      "--output-format stream-json --verbose",
      `--mcp-config ${quote(mcp)} --strict-mcp-config`,
      `--allowedTools ${quote(allowed.join(","))}`,
      `--disallowedTools ${quote(refused.join(","))}`,
      ...(plan.model ? [`--model ${quote(plan.model)}`] : []),
    ].join(" ");
  } else {
    // With an API key, Codex is pointed at the provider that takes it (OpenAI's, or another that speaks the Responses API).
    const provider = plan.env.BOT_CODEX_KEY
      ? [
          "-c model_provider=bot",
          `-c ${quote(`model_providers.bot.base_url="${plan.env.BOT_CODEX_BASE_URL || "https://api.openai.com/v1"}"`)}`,
          `-c ${quote('model_providers.bot.env_key="BOT_CODEX_KEY"')}`,
          `-c ${quote('model_providers.bot.wire_api="responses"')}`,
          `-c ${quote('model_providers.bot.name="bot"')}`,
        ]
      : [];
    cli = [
      bin,
      "exec --json --skip-git-repo-check",
      plan.builtins ? "--sandbox workspace-write" : "--sandbox read-only",
      `-c ${quote(`mcp_servers.bot.url="${plan.toolsUrl}"`)}`,
      `-c ${quote('mcp_servers.bot.bearer_token_env_var="BOT_RUN_SECRET"')}`,
      // Codex asks before every MCP call, and `exec` has no one to ask: eve-bot's tools gate what needs a person themselves.
      `-c ${quote('mcp_servers.bot.default_tools_approval_mode="approve"')}`,
      ...provider,
      ...(plan.model ? [`-m ${quote(plan.model)}`] : []),
      `"$(cat ${dir}/prompt.md)"`,
    ].join(" ");
  }
  const body = `cd ${quote(plan.workingDirectory)} 2>/dev/null || cd ${quote(dir)}; ${cli} > ${dir}/events.jsonl 2> ${dir}/stderr.log < /dev/null; echo $? > ${dir}/exit`;
  return `nohup setsid bash -c ${quote(body)} > /dev/null 2>&1 &`;
}

/** One look's worth of what the CLI wrote, read by the computer's own user. */
export function readCommand(runId: string, offset: number, limit = 256 * 1024): string {
  const dir = runDir(runId);
  return [
    `if [ -f ${dir}/exit ]; then echo "exit:$(cat ${dir}/exit)"; else echo "exit:"; fi`,
    `echo "size:$(stat -c %s ${dir}/events.jsonl 2>/dev/null || echo 0)"`,
    "echo ---",
    `tail -c +${offset + 1} ${dir}/events.jsonl 2>/dev/null | head -c ${limit}`,
  ].join("; ");
}

export interface LocalLook {
  readonly ended: boolean;
  /** The exit code once ended; null while running or when unknown. */
  readonly exitCode: number | null;
  /** How many bytes of the stream have been read, through the last whole line. */
  readonly cursor: number;
  readonly said: readonly string[];
  /** Set once the CLI reported how its turn ended. */
  readonly outcome: { readonly ok: boolean; readonly error: string | null; readonly usd: number | null; readonly model: string | null } | null;
}

/**
 * Reads what one look found: the exit code, and the stream from `offset`.
 * Only whole lines count; a line still being written waits for the next look.
 * Claude Code's `stream-json` and Codex's `--json` are told apart by shape.
 */
export function parseLook(output: string, offset: number): LocalLook {
  const [head = "", ...rest] = output.split("\n---\n");
  const exitText = /^exit:(\d*)$/m.exec(head)?.[1] ?? "";
  const exitCode = exitText === "" ? null : Number(exitText);
  const body = rest.join("\n---\n");
  const complete = body.lastIndexOf("\n") + 1;
  const lines = body.slice(0, complete).split("\n").filter((line) => line.trim() !== "");
  const said: string[] = [];
  let outcome: LocalLook["outcome"] = null;
  for (const line of lines) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    // Claude Code: assistant messages carry text parts; the result ends the turn.
    if (event.type === "assistant") {
      const content = (event.message as { content?: readonly { type?: string; text?: string }[] } | undefined)?.content ?? [];
      const text = content.filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text!.trim()).filter((part) => part !== "").join("\n\n");
      if (text !== "") said.push(text);
    } else if (event.type === "result") {
      const failed = event.is_error === true || (typeof event.subtype === "string" && event.subtype !== "success");
      const usd = typeof event.total_cost_usd === "number" ? event.total_cost_usd : null;
      const model = Object.keys((event.modelUsage as Record<string, unknown> | undefined) ?? {})[0] ?? null;
      outcome = { ok: !failed, error: failed ? withoutKeys(String(event.result ?? event.subtype ?? "The turn failed.")) : null, usd, model };
    }
    // Codex: an agent message is its words; the turn's end or failure, and errors, end it.
    else if (event.type === "item.completed") {
      const item = event.item as { type?: string; text?: string } | undefined;
      if (item?.type === "agent_message" && typeof item.text === "string" && item.text.trim() !== "") said.push(item.text.trim());
    } else if (event.type === "turn.completed") {
      outcome = { ok: true, error: null, usd: null, model: null };
    } else if (event.type === "turn.failed" || event.type === "error") {
      const message = (event.error as { message?: string } | undefined)?.message ?? (typeof event.message === "string" ? event.message : "The turn failed.");
      // Codex reports each retry as an error and goes on; only its last word on the turn counts.
      if (event.type === "error" && /^Reconnecting\b/.test(message)) continue;
      outcome = { ok: false, error: withoutKeys(message), usd: null, model: null };
    }
  }
  const ended = exitCode !== null;
  return { ended, exitCode, cursor: offset + Buffer.byteLength(body.slice(0, complete)), said, outcome };
}

/**
 * An error as the CLI wrote it, with any key in it hidden: a provider that
 * refuses a key often repeats part of it (`vck_0sx2****UwLB`), and the error
 * is shown in the Bot's thread.
 */
export function withoutKeys(text: string): string {
  return text
    .replace(/[\w-]{2,16}\*{4,}[\w-]{0,8}/g, "[a key, hidden]")
    .replace(/\b(sk-[\w-]{8,}|vck_[\w-]{8,}|sk-ant-[\w-]{8,})/g, "[a key, hidden]");
}

/** What a look tells `run_job`: still working, or how it ended. */
export function lookResult(look: LocalLook, stderrTail: string): { readonly kind: "working" } | { readonly kind: "ended"; readonly ok: true } | { readonly kind: "ended"; readonly ok: false; readonly error: string } {
  if (!look.ended) return { kind: "working" };
  if (look.outcome !== null) return look.outcome.ok ? { kind: "ended", ok: true } : { kind: "ended", ok: false, error: look.outcome.error ?? "The turn failed." };
  if (look.exitCode === 0) return { kind: "ended", ok: true };
  const reason = withoutKeys(stderrTail).trim().split("\n").slice(-3).join(" ").slice(0, 400);
  return { kind: "ended", ok: false, error: `The CLI stopped (exit ${look.exitCode})${reason === "" ? "." : `: ${reason}`}` };
}

export type { ComputerIo };
