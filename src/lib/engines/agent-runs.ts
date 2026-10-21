/**
 * Vercel Agent Runs for Claude Code and Codex sessions: each turn, with its
 * model and tool calls, timing and spend, under the project's Observability
 * tab, next to eve's own sessions. The engines' agent modules import this, so
 * it is built only with `BOT_ENGINES` on, and it registers once per process
 * before the queue route drives a turn.
 *
 * Sessions have no audience, so their traces keep metadata only (models,
 * tools, timing, usage): no brief, no reply, no tool input or output. Off the
 * Vercel platform there is nowhere to send them, so nothing registers.
 */
import { agentRuns } from "durable-harness/instrumentation/otel";

const registered = Symbol.for("eve-bot.agent-runs");

export function registerAgentRuns(env: Readonly<Record<string, string | undefined>> = process.env): void {
  const host = globalThis as { [registered]?: true };
  if (host[registered] || env.VERCEL !== "1") return;
  host[registered] = true;
  try {
    agentRuns({ serviceName: "eve-bot", onError: (error) => console.warn("[agent-runs]", error instanceof Error ? error.message : error) }).register();
  } catch (error) {
    // Tracing never stops a turn.
    console.warn("[agent-runs] not registered:", error instanceof Error ? error.message : error);
  }
}
