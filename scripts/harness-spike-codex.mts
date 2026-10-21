/**
 * H4's live check (docs/plan/harness-engines.md): does a Codex session run the
 * way the Claude Code spike showed one does? One session, one `never` tool,
 * and the same answers that `run_job` depends on: the run id a tool sees is the
 * session id, a turn's end shows as `idle`, and spend is in the log.
 *
 * This SPENDS MONEY: AI Gateway credits for one short Codex turn, and Vercel
 * Sandbox time and Drive storage for one session. It refuses to run without
 * --yes-spend, and deletes the session's Sandbox and Drive at the end.
 *
 * Needs AI_GATEWAY_API_KEY and a fresh VERCEL_OIDC_TOKEN in the environment.
 *
 *   WORKFLOW_LOCAL_DATA_DIR=/tmp/h4-world npx tsx scripts/harness-spike-codex.mts --yes-spend
 */
import { codex } from "durable-harness/codex";
import { deleteSessionSandbox, sandbox } from "durable-harness/sandbox";
import type { HostTool } from "durable-harness/tools";

if (!process.argv.includes("--yes-spend")) {
  console.error("This spends AI Gateway credits and Vercel Sandbox time. Run it again with --yes-spend to go ahead.");
  process.exit(2);
}

// The harness finds the project from VERCEL_PROJECT_ID; a pulled OIDC token names it.
if (!process.env.VERCEL_PROJECT_ID && process.env.VERCEL_OIDC_TOKEN) {
  const claims = JSON.parse(Buffer.from(process.env.VERCEL_OIDC_TOKEN.split(".")[1] ?? "", "base64url").toString("utf8")) as { project_id?: string };
  if (claims.project_id) process.env.VERCEL_PROJECT_ID = claims.project_id;
}

const MODEL = process.env.SPIKE_CODEX_MODEL ?? "openai/gpt-5.4-mini";
const seenRunIds = new Set<string>();
let stamped = 0;

const stamp: HostTool = {
  name: "stamp",
  description: "Stamp the job once. Call it exactly once, then end your turn.",
  inputSchema: { type: "object", properties: { note: { type: "string" } }, required: ["note"] },
  replay: "never",
  async execute(_input: { note: string }, io) {
    seenRunIds.add(io.ctx.runId);
    stamped += 1;
    return "stamped";
  },
};

const agent = codex({
  name: "eve-bot-h4-spike",
  model: MODEL,
  tools: [stamp],
  builtins: false,
  workspace: sandbox({ network: "deny-all", idleMs: 5_000, budget: { turnUsd: 1, sessionUsd: 1, vmSeconds: 600 } }),
});

type State = Awaited<ReturnType<typeof agent.sessions.inspect>>;

function spent(state: State): number {
  let usd = 0;
  for (const effect of state.effectOrder) {
    if (effect.name !== "journal" || effect.status !== "completed") continue;
    const batch = effect.input as { streams?: Record<string, { entries: { data?: { usd?: number } }[] }> };
    // Codex writes its spend to `codex.spend` (Claude Code's goes to `hw.spend`).
    for (const entry of batch.streams?.["codex.spend"]?.entries ?? []) usd += typeof entry.data?.usd === "number" ? entry.data.usd : 0;
  }
  return usd;
}

const results: Record<string, string> = {};
let sessionId: string | null = null;
try {
  ({ sessionId } = await agent.sessions.start());
  console.log(`session: ${sessionId} (${MODEL})`);
  const events: string[] = [];
  const stop = new AbortController();
  const live = (async () => {
    try {
      for await (const { value } of agent.sessions.liveEntries(sessionId!, { signal: stop.signal })) {
        const type = (value as { type?: string })?.type ?? "?";
        events.push(type);
        if (type === "idle" || type === "error") break;
      }
    } catch {
      // Aborted below.
    }
  })();
  await agent.sessions.send(sessionId, 'Call the stamp tool once with note "h4", then end your turn.');
  const deadline = Date.now() + 300_000;
  await Promise.race([live, new Promise((resolve) => setTimeout(resolve, Math.max(0, deadline - Date.now())))]);
  stop.abort();
  const state = await agent.sessions.inspect(sessionId);
  results["codex ran a turn"] = events.includes("idle") ? "PASS" : `FAIL (status ${state.status}; events ${events.join(" ")})`;
  results["tool runId is the session id"] = seenRunIds.size === 1 && seenRunIds.has(sessionId) ? "PASS" : `FAIL (tools saw ${[...seenRunIds].join(", ") || "nothing"})`;
  results["never tool ran once"] = stamped === 1 ? "PASS" : `FAIL (ran ${stamped} times)`;
  const usd = spent(state);
  results["spend is in the log"] = usd > 0 ? `PASS ($${usd.toFixed(4)})` : "FAIL (no codex.spend records)";
  console.log(`live events: ${events.join(" ")}`);
} catch (error) {
  console.error("spike stopped:", error);
} finally {
  if (sessionId !== null) {
    await agent.sessions.close(sessionId).catch(() => undefined);
    console.log("cleaned up:", JSON.stringify(await deleteSessionSandbox(sessionId, { force: true }).catch((error: unknown) => String(error))));
  }
}
console.log("\nH4 results");
for (const [question, answer] of Object.entries(results)) console.log(`- ${question}: ${answer}`);
process.exit(0);
