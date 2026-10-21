/**
 * H0, the live half (docs/plan/harness-engines.md, section 6): four questions
 * about durable-harness that only a real session answers, each pass or fail.
 *
 *   1. A session killed mid-tool: did its `replay: 'never'` tool run exactly once?
 *   2. Does `sessions.close` stop a turn that is running?
 *   3. Can a session's spend be read from its log while it runs?
 *   4. Does the queue route deliver next to eve's service on a deployment?
 *      Not answerable from here: see the note printed at the end.
 *
 * This SPENDS MONEY: AI Gateway credits for a few short Claude Code turns, and
 * Vercel Sandbox time and Drive storage for three sessions, on whatever
 * account the credentials below belong to. It refuses to run without
 * --yes-spend. Every session's Sandbox and Drive are deleted at the end.
 *
 * Needs, in the environment (never in this file): AI_GATEWAY_API_KEY, and
 * either `vercel link` in this folder or VERCEL_TOKEN, VERCEL_TEAM_ID and
 * VERCEL_PROJECT_ID. Runs on the local World (.workflow-data), no deployment.
 *
 *   npx tsx scripts/harness-spike.mts --yes-spend
 */
import { claudeCode } from "durable-harness/claude-code";
import { deleteSessionSandbox, sandbox } from "durable-harness/sandbox";
import type { HostTool } from "durable-harness/tools";

if (!process.argv.includes("--yes-spend")) {
  console.error("This spends AI Gateway credits and Vercel Sandbox time. Run it again with --yes-spend to go ahead.");
  process.exit(2);
}

/** Caps for the spike itself, so a runaway turn costs little. */
const SPIKE_BUDGET = { turnUsd: 1, sessionUsd: 2, vmSeconds: 900 };
const credentials =
  process.env.VERCEL_TOKEN && process.env.VERCEL_TEAM_ID && process.env.VERCEL_PROJECT_ID
    ? { token: process.env.VERCEL_TOKEN, teamId: process.env.VERCEL_TEAM_ID, projectId: process.env.VERCEL_PROJECT_ID }
    : undefined;

class Crash extends Error {}

/** Runs of the `never` tool, by call: the answer to question 1. */
const stamps = new Map<string, number>();
let toolStarted: (() => void) | null = null;
let toolAborted = false;

const stamp: HostTool = {
  name: "stamp",
  description: "Stamp the job once. Call it exactly once, then end your turn.",
  inputSchema: { type: "object", properties: { note: { type: "string" } }, required: ["note"] },
  replay: "never",
  async execute(input: { note: string }, io) {
    const key = `${io.ctx.runId}:${input.note}`;
    stamps.set(key, (stamps.get(key) ?? 0) + 1);
    // Long enough for the crash armed below to land inside it.
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    return "stamped";
  },
};

const wait: HostTool = {
  name: "wait",
  description: "Wait for the given number of seconds.",
  inputSchema: { type: "object", properties: { seconds: { type: "number" } }, required: ["seconds"] },
  replay: "safe",
  async execute(input: { seconds: number }, io) {
    toolStarted?.();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, input.seconds * 1000);
      io.signal.addEventListener("abort", () => {
        toolAborted = true;
        clearTimeout(timer);
        resolve();
      });
    });
    return "waited";
  },
};

const agent = claudeCode({
  name: "eve-bot-h0-spike",
  tools: [stamp, wait],
  builtins: false,
  workspace: sandbox({ network: "deny-all", idleMs: 30_000, budget: SPIKE_BUDGET, ...(credentials ? { credentials } : {}) }),
  chaos: true,
  crash: () => {
    throw new Crash("chaos");
  },
});

const sessions: string[] = [];
const results: Record<string, string> = {};

async function drive(sessionId: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await agent.sessions.drive(sessionId);
      return;
    } catch (error) {
      if (!(error instanceof Crash)) throw error;
      console.log(`  drive ${attempt + 1} crashed on purpose; driving again from the log`);
    }
  }
}

async function check1(): Promise<void> {
  const { sessionId } = await agent.sessions.start();
  sessions.push(sessionId);
  await agent.sessions.chaos(sessionId, { at: "tool", afterMs: 1_000 });
  await agent.sessions.send(sessionId, 'Call the stamp tool once with note "h0", then end your turn.');
  await drive(sessionId);
  const runs = stamps.get(`${sessionId}:h0`) ?? 0;
  results["1. never tool ran once after a crash"] = runs === 1 ? "PASS" : `FAIL (ran ${runs} times)`;
}

async function check2and3(): Promise<void> {
  const { sessionId } = await agent.sessions.start();
  sessions.push(sessionId);
  const started = new Promise<void>((resolve) => (toolStarted = resolve));
  await agent.sessions.send(sessionId, "Call the wait tool with seconds 120, then end your turn.");
  const driving = drive(sessionId).catch((error: unknown) => error);
  await started;
  // 3: what the log says about spend while the turn runs.
  const state = await agent.sessions.inspect(sessionId);
  const spendDocs = [...state.docs.keys()].filter((name) => /spend|budget|ledger/i.test(name));
  results["3. spend readable mid-run"] = spendDocs.length > 0 ? `PASS? (documents: ${spendDocs.join(", ")}; check their values)` : "FAIL (no spend document in the log mid-run)";
  // 2: close it while the tool waits.
  const closedAt = Date.now();
  await agent.sessions.close(sessionId);
  const settled = await Promise.race([driving.then(() => "ended"), new Promise((resolve) => setTimeout(() => resolve("still running"), 30_000))]);
  results["2. close stops a running turn"] =
    settled === "ended" && toolAborted ? `PASS (stopped in ${Math.round((Date.now() - closedAt) / 1000)}s)` : `FAIL (${settled}, tool aborted: ${toolAborted}); fallback is deleteSessionSandbox on cancel`;
}

try {
  await check1();
  await check2and3();
} finally {
  for (const sessionId of sessions) {
    await agent.sessions.close(sessionId).catch(() => undefined);
    const deleted = await deleteSessionSandbox(sessionId, { force: true, ...(credentials ? { credentials } : {}) }).catch((error: unknown) => String(error));
    console.log(`cleaned up ${sessionId}:`, deleted);
  }
}

results["4. queue route next to eve's service"] = "NOT RUN HERE: needs a preview deployment of this branch with BOT_ENGINES=claude-code";
console.log("\nH0 results");
for (const [question, answer] of Object.entries(results)) console.log(`- ${question}: ${answer}`);
