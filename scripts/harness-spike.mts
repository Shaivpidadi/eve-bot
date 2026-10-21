/**
 * H0, the live half (docs/plan/harness-engines.md, section 6): what only a
 * real durable-harness session can tell us, each answered pass or fail.
 *
 *   1. Is the run id a HostTool sees (`io.ctx.runId`) the session id
 *      `sessions.start()` returned? The run fence keys on it.
 *   2. Does a live `idle` event mean the turn ended in the log?
 *   3. Does `sessions.close` stop a turn that is running?
 *   4. Can a session's spend be read from its log while it runs?
 *   5. Does the queue route deliver next to eve's service on a deployment?
 *      Not answerable from here: see the note printed at the end.
 *
 * Along the way: a session crashed mid-tool must not run its `replay: 'never'`
 * tool twice.
 *
 * This SPENDS MONEY: AI Gateway credits for a few short Claude Code turns, and
 * Vercel Sandbox time and Drive storage for two sessions, on whatever account
 * the credentials below belong to. It refuses to run without --yes-spend.
 * Every session's Sandbox and Drive are deleted at the end.
 *
 * Needs, in the environment (never in this file): AI_GATEWAY_API_KEY, and
 * either a fresh VERCEL_OIDC_TOKEN (`vercel env pull .env.local`) or
 * VERCEL_TOKEN, VERCEL_TEAM_ID and VERCEL_PROJECT_ID. Runs on the local World
 * (WORKFLOW_LOCAL_DATA_DIR, else .workflow-data), no deployment.
 *
 *   set -a; source .env; source .env.local; set +a
 *   WORKFLOW_LOCAL_DATA_DIR=/tmp/h0-world npx tsx scripts/harness-spike.mts --yes-spend
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

// The harness looks for the project in VERCEL_PROJECT_ID or .vercel/project.json,
// but this repo is linked through .vercel/repo.json. A pulled OIDC token names
// its project, so take the id from there.
if (!credentials && !process.env.VERCEL_PROJECT_ID && process.env.VERCEL_OIDC_TOKEN) {
  const claims = JSON.parse(Buffer.from(process.env.VERCEL_OIDC_TOKEN.split(".")[1] ?? "", "base64url").toString("utf8")) as { project_id?: string; exp?: number };
  if (claims.exp && claims.exp * 1000 < Date.now()) {
    console.error("VERCEL_OIDC_TOKEN has expired. Run `vercel env pull .env.local` and try again.");
    process.exit(2);
  }
  if (claims.project_id) process.env.VERCEL_PROJECT_ID = claims.project_id;
}

class Crash extends Error {}

/** Runs of the `never` tool, by run id and note. */
const stamps = new Map<string, number>();
/** The run ids tools saw. */
const seenRunIds = new Set<string>();
let toolStarted: (() => void) | null = null;
let toolAborted = false;

const stamp: HostTool = {
  name: "stamp",
  description: "Stamp the job once. Call it exactly once, then end your turn.",
  inputSchema: { type: "object", properties: { note: { type: "string" } }, required: ["note"] },
  replay: "never",
  async execute(input: { note: string }, io) {
    seenRunIds.add(io.ctx.runId);
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
    seenRunIds.add(io.ctx.runId);
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
  workspace: sandbox({ network: "deny-all", idleMs: 5_000, budget: SPIKE_BUDGET, ...(credentials ? { credentials } : {}) }),
  chaos: true,
  crash: () => {
    throw new Crash("chaos");
  },
});

type State = Awaited<ReturnType<typeof agent.sessions.inspect>>;

/**
 * Records of one journal stream, folded from the log the way durable-harness
 * does it (`journalRecords`, not exported): completed `journal` effects, in
 * order, each holding a batch of entries per stream.
 */
function journal(state: State, stream: string): unknown[] {
  const out: unknown[] = [];
  for (const effect of state.effectOrder) {
    if (effect.name !== "journal" || effect.status !== "completed") continue;
    const batch = effect.input as { streams?: Record<string, { entries: { data?: unknown }[] }> };
    for (const entry of batch.streams?.[stream]?.entries ?? []) out.push(entry.data);
  }
  return out;
}

/** Model spend so far, from the `hw.spend` stream the gateway handler writes. */
function spent(state: State): { usd: number; records: number } {
  const records = journal(state, "hw.spend") as { usd?: number }[];
  return { usd: records.reduce((sum, r) => sum + (typeof r?.usd === "number" ? r.usd : 0), 0), records: records.length };
}

/** Tail a session's live events until aborted, noting what the log said when each `idle` arrived. */
function tail(sessionId: string, signal: AbortSignal) {
  const events: string[] = [];
  const atIdle: { turnEnded: boolean; pending: number; status: string }[] = [];
  const done = (async () => {
    try {
      for await (const { value } of agent.sessions.liveEntries(sessionId, { signal })) {
        const type = (value as { type?: string })?.type ?? "?";
        events.push(type);
        if (type !== "idle") continue;
        const state = await agent.sessions.inspect(sessionId);
        const transcript = journal(state, "transcript") as { type?: string }[];
        const placed = new Set([...state.placed, ...state.withdrawn]);
        atIdle.push({
          turnEnded: transcript.at(-1)?.type === "turn",
          pending: state.submissions.filter((s) => s.kind !== "chaos" && s.kind !== "withdraw" && !placed.has(s.id)).length,
          status: state.status,
        });
      }
    } catch (error) {
      if (!signal.aborted) events.push(`tail error: ${String(error)}`);
    }
  })();
  return { events, atIdle, done };
}

const sessions: string[] = [];
const results: Record<string, string> = {};
const notes: string[] = [];

/**
 * Wait, by reading the log, for the session's turn to end. `send` queues a
 * message that the local World delivers to this agent's queue consumer in
 * this process, the way a Vercel deployment's flow route gets it, so the
 * spike does not drive the session itself: a second `sessions.drive` finds it
 * held ("contended") and returns at once, which run 3 took for the turn's end.
 * A chaos crash throws out of that consumer and the queue delivers again.
 */
async function turnEnd(sessionId: string, timeoutMs = 300_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await agent.sessions.inspect(sessionId);
    if (state.status !== "running") return state.status;
    const transcript = journal(state, "transcript") as { type?: string }[];
    const placed = new Set([...state.placed, ...state.withdrawn]);
    const pending = state.submissions.filter((s) => s.kind !== "chaos" && s.kind !== "withdraw" && !placed.has(s.id)).length;
    if (pending === 0 && transcript.at(-1)?.type === "turn") return "ended";
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return "timed out";
}

/** A turn with a crash inside the `never` tool: questions 1 and 2, and the replay check. */
async function check1and2(): Promise<void> {
  const { sessionId } = await agent.sessions.start();
  sessions.push(sessionId);
  console.log(`session 1: ${sessionId}`);
  const stop = new AbortController();
  const live = tail(sessionId, stop.signal);
  await agent.sessions.chaos(sessionId, { at: "tool", afterMs: 1_000 });
  await agent.sessions.send(sessionId, 'Call the stamp tool once with note "h0", then end your turn.');
  const ended = await turnEnd(sessionId);
  notes.push(`session 1 turn: ${ended}`);
  // Let the tail catch up with what the drive wrote.
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  stop.abort();
  await live.done;

  const state = await agent.sessions.inspect(sessionId);
  notes.push(`session 1 state.runId=${state.runId}; tools saw ${[...seenRunIds].join(", ") || "nothing"}`);
  results["1. tool runId is the session id"] =
    seenRunIds.size === 1 && seenRunIds.has(sessionId) && state.runId === sessionId ? "PASS" : `FAIL (session ${sessionId}, tools saw ${[...seenRunIds].join(", ")}, state.runId ${state.runId})`;

  notes.push(`session 1 live events: ${live.events.join(" ")}`);
  notes.push(`session 1 log at each idle: ${JSON.stringify(live.atIdle)}`);
  const idles = live.atIdle.length;
  results["2. live idle means the turn ended"] =
    idles > 0 && live.atIdle.every((i) => i.turnEnded && i.pending === 0)
      ? `PASS (${idles} idle event(s); each time the log's last transcript entry was the turn's end and nothing was pending)`
      : `FAIL (${JSON.stringify(live.atIdle)})`;

  const runs = stamps.get(`${sessionId}:h0`) ?? 0;
  results["(replay) never tool ran once after a crash"] = runs === 1 ? "PASS" : `FAIL (ran ${runs} times)`;
  notes.push(`session 1 spend: ${JSON.stringify(spent(state))}`);
}

/** A long tool call, closed while it waits: questions 3 and 4. */
async function check3and4(): Promise<void> {
  const { sessionId } = await agent.sessions.start();
  sessions.push(sessionId);
  console.log(`session 2: ${sessionId}`);
  const started = new Promise<void>((resolve) => (toolStarted = resolve));
  await agent.sessions.send(sessionId, "Call the wait tool with seconds 120, then end your turn.");
  const reached = await Promise.race([started.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 180_000))]);
  if (!reached) throw new Error(`session 2 never reached the wait tool in 3 minutes (status ${(await agent.sessions.inspect(sessionId)).status})`);

  // 4: what the log says about spend while the turn runs (the tool is mid-call).
  const midA = spent(await agent.sessions.inspect(sessionId));
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  const midB = spent(await agent.sessions.inspect(sessionId));
  notes.push(`session 2 spend mid-run: at tool start ${JSON.stringify(midA)}, 3s later ${JSON.stringify(midB)}`);
  results["4. spend readable mid-run"] =
    midB.records > 0 && midB.usd > 0
      ? `PASS ($${midB.usd.toFixed(4)} over ${midB.records} model call(s), read from the log's hw.spend stream while the tool ran)`
      : `FAIL (no hw.spend records in the log mid-run: ${JSON.stringify(midB)})`;

  // 3: close it while the tool waits.
  const closedAt = Date.now();
  await agent.sessions.close(sessionId);
  const atClose = (await agent.sessions.inspect(sessionId)).eventCount;
  for (let waited = 0; waited < 30 && !toolAborted; waited += 1) await new Promise((resolve) => setTimeout(resolve, 1_000));
  const stoppedIn = Math.round((Date.now() - closedAt) / 1000);
  // Anything the drive writes after the close is a turn that kept going.
  await new Promise((resolve) => setTimeout(resolve, 5_000));
  const after = await agent.sessions.inspect(sessionId);
  notes.push(`session 2 after close: tool aborted ${toolAborted}, status ${after.status}, log events at close ${atClose}, 5s after ${after.eventCount}`);
  results["3. close stops a running turn"] =
    toolAborted && after.eventCount === atClose
      ? `PASS (the running tool was aborted ${stoppedIn}s after close and nothing more was written)`
      : `FAIL (tool aborted: ${toolAborted}; log grew ${after.eventCount - atClose} events after close); fallback is deleteSessionSandbox on cancel`;
  notes.push(`session 2 final spend: ${JSON.stringify(spent(after))}`);
}

try {
  await check1and2();
  await check3and4();
} catch (error) {
  console.error("spike stopped:", error);
} finally {
  for (const sessionId of sessions) {
    await agent.sessions.close(sessionId).catch(() => undefined);
    const deleted = await deleteSessionSandbox(sessionId, { force: true, ...(credentials ? { credentials } : {}) }).catch((error: unknown) => String(error));
    console.log(`cleaned up ${sessionId}:`, JSON.stringify(deleted));
  }
}

results["5. queue route next to eve's service"] = "NOT RUN HERE: needs a preview deployment of this branch with BOT_ENGINES=claude-code";
console.log("\nNotes");
for (const note of notes) console.log(`- ${note}`);
console.log("\nH0 results");
for (const [question, answer] of Object.entries(results)) console.log(`- ${question}: ${answer}`);
// The local World's queue keeps timers alive; the spike is done.
process.exit(0);
