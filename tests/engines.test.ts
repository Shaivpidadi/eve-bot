import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Bot, Job } from "../agent/lib/types";

/**
 * Bots on another engine (agent/lib/engines): the switch, the checks that
 * keep a harness Bot from running where it must not, and the three eve-bot
 * tools a Claude Code session gets, fenced on the job's run exactly as the
 * teammate's tools are. durable-harness itself is never loaded here: the
 * session is a stand-in that records what it was asked.
 */

const WORKSPACE = "default";

describe("the engine switch", () => {
  it("is off unless BOT_ENGINES names an engine", async () => {
    const { enabledEngines, enginesOn } = await import("../agent/lib/engines");
    expect(enabledEngines({})).toEqual([]);
    expect(enabledEngines({ BOT_ENGINES: "off" })).toEqual([]);
    expect(enabledEngines({ BOT_ENGINES: "nonsense" })).toEqual([]);
    expect(enabledEngines({ BOT_ENGINES: "codex, nonsense" })).toEqual(["codex"]);
    expect(enabledEngines({ BOT_ENGINES: "claude-code,codex" })).toEqual(["claude-code", "codex"]);
    expect(enabledEngines({ BOT_ENGINES: " Claude-Code " })).toEqual(["claude-code"]);
    expect(enginesOn({ BOT_ENGINES: "claude-code" })).toBe(true);
    expect(enginesOn({})).toBe(false);
  });

  it("leaves every existing Bot on eve", async () => {
    const { engineOf } = await import("../agent/lib/engines");
    expect(engineOf({})).toBe("eve");
    expect(engineOf(null)).toBe("eve");
    expect(engineOf({ engine: "claude-code" })).toBe("claude-code");
  });

  it("refuses a harness engine when it is off, for a tenant, or where it would drop a data control", async () => {
    const { engineRefusal } = await import("../agent/lib/engines");
    const on = { BOT_ENGINES: "claude-code" };
    expect(engineRefusal("eve", { workspaceId: "tenant", env: {} })).toBeNull();
    expect(engineRefusal("claude-code", { workspaceId: WORKSPACE, env: {} })).toMatch(/off on this deployment/);
    expect(engineRefusal("claude-code", { workspaceId: WORKSPACE, env: on })).toBeNull();
    expect(engineRefusal("claude-code", { workspaceId: "tenant", env: on })).toMatch(/owner's workspace/);
    expect(engineRefusal("claude-code", { workspaceId: "mine", env: { ...on, BOT_DEFAULT_WORKSPACE: "mine" } })).toBeNull();
    expect(engineRefusal("claude-code", { workspaceId: WORKSPACE, env: { ...on, BOT_ZDR: "1" } })).toMatch(/Zero Data Retention/);
    expect(engineRefusal("claude-code", { workspaceId: WORKSPACE, env: { ...on, BOT_INFERENCE_REGION: "us" } })).toMatch(/inference region/);
    expect(engineRefusal("claude-code", { workspaceId: WORKSPACE, env: { ...on, BOT_MODEL_BASE_URL: "http://localhost:11434/v1" } })).toMatch(/AI Gateway/);
  });
});

describe("a Claude Code session's settings", () => {
  it("have no built-ins, no network and a spend cap at the job's limit", async () => {
    const { claudeCodeOptions } = await import("../agent/lib/engines/claude-code");
    const sandbox = vi.fn((options: unknown) => ({ kind: "sandbox", options }) as never);
    const options = claudeCodeOptions(sandbox, { BOT_JOB_COST_LIMIT_USD: "3" });
    expect(options.builtins).toBe(false);
    expect(options.name).toBe("eve-bot-claude-code");
    expect(options.model).toBeUndefined();
    expect((options.tools ?? []).map((tool) => [tool.name, tool.replay])).toEqual([
      ["job_brief", "safe"],
      ["log_progress", "safe"],
      ["finish_job", "never"],
      ["send_email", "never"],
    ]);
    expect(sandbox).toHaveBeenCalledWith(expect.objectContaining({ network: "deny-all", budget: { turnUsd: 3, sessionUsd: 3 } }));
    expect(claudeCodeOptions(sandbox, { BOT_CLAUDE_CODE_MODEL: "anthropic/claude-sonnet-4.5" }).model).toBe("anthropic/claude-sonnet-4.5");
  });
});

describe("a Claude Code Bot's brief", () => {
  it("carries the job and the working agreement, but never the run token", async () => {
    const { renderHarnessBrief } = await import("../agent/lib/engines/brief");
    const bot = { name: "Cody", emoji: "🧑‍💻", role: "Writes small scripts", persona: "Careful and brief.", playbook: ["Say what you could not check."] } as Bot;
    const job = {
      id: "job_1",
      title: "Draft a changelog",
      requestedBy: "Shaishav",
      brief: "Summarise the last release.",
      successCriteria: ["Three bullets"],
      feedback: null,
      result: null,
      journal: [],
      lease: { token: "lease_secret" },
    } as unknown as Job;
    const brief = renderHarnessBrief(bot, job);
    expect(brief).toContain("Draft a changelog");
    expect(brief).toContain("Three bullets");
    expect(brief).toContain("Say what you could not check.");
    expect(brief).toContain("finish_job");
    expect(brief).not.toContain("lease_secret");
    expect(brief).not.toContain("—");
  });
});

type Tool = { execute: (input: unknown, io: { ctx: { runId: string; config: unknown } }) => Promise<string> };

async function setup() {
  const jobs = await import("../agent/lib/jobs");
  const { hireBot } = await import("../agent/lib/bots");
  const tools = await import("../agent/lib/engines/host-tools");
  const bot = await hireBot({ workspaceId: WORKSPACE, hiredBy: "owner", name: "Cody", role: "Writes small scripts", persona: "Careful, and says what it could not check." });
  const job = await jobs.assignJob({ workspaceId: WORKSPACE, botId: bot.id, requestedBy: "owner", title: "Draft a changelog", brief: "Summarise the last release." });
  /** Claims the job as a run. `lapsed` leaves the lease already expired, so the next claim takes the job over. */
  const claim = async (token: string, lapsed = false) => {
    const claimed = await jobs.claimJob(WORKSPACE, job.id, { token, forMs: lapsed ? 0 : 20 * 60_000, status: "running", kind: "run", countAttempt: true });
    expect(claimed.ok).toBe(true);
  };
  const io = (runId: string, config: unknown = { workspaceId: WORKSPACE, jobId: job.id }) => ({ ctx: { runId, config } });
  const call = async (tool: Tool, input: unknown, runId: string, config?: unknown) => JSON.parse(await tool.execute(input, io(runId, config))) as Record<string, unknown>;
  const read = async () => (await jobs.getJob(WORKSPACE, job.id)) as Job;
  return { jobs, tools, bot, job, claim, call, read };
}

describe("a Claude Code session's tools", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("BOT_STORE", "memory");
  });

  it("work only for the session bound to the job's run, and record a result that names the run", async () => {
    const { jobs, tools, job, claim, call, read } = await setup();
    await claim("lease_A");
    // Before run_job binds the session, nothing is the run.
    expect(await call(tools.jobBrief, {}, "sess_A")).toMatchObject({ ok: false });
    expect((await jobs.bindRun(WORKSPACE, job.id, "lease_A", "sess_A")).ok).toBe(true);

    const brief = await call(tools.jobBrief, {}, "sess_A");
    expect(brief).toMatchObject({ ok: true, job: { id: job.id, title: "Draft a changelog" }, you: { name: "Cody" } });
    expect(await call(tools.logProgress, { note: "Read the release notes" }, "sess_A")).toEqual({ ok: true });
    // A replayed log line is not written twice.
    await call(tools.logProgress, { note: "Read the release notes" }, "sess_A");
    expect((await read()).journal?.filter((entry) => entry.text === "Read the release notes")).toHaveLength(1);

    // Another session, or a model naming another job, gets nothing.
    expect(await call(tools.logProgress, { note: "I am not the run" }, "sess_B")).toMatchObject({ ok: false });
    expect(await call(tools.jobBrief, { jobId: "job_other" }, "sess_A")).toMatchObject({ ok: true, job: { id: job.id } });
    expect(await call(tools.jobBrief, {}, "sess_A", {})).toMatchObject({ ok: false });

    expect(await call(tools.finishJob, { summary: "Wrote three bullets", deliverable: "- a\n- b\n- c", needsHuman: false, verified: true }, "sess_A")).toMatchObject({
      ok: true,
      recorded: true,
    });
    expect((await read()).result).toMatchObject({ summary: "Wrote three bullets", completion: "verified", producedBy: { token: "lease_A", session: "sess_A" } });
  });

  it("refuse everything once the job is cancelled or another run takes it", async () => {
    const { jobs, tools, job, claim, call, read } = await setup();
    await claim("lease_A");
    await jobs.bindRun(WORKSPACE, job.id, "lease_A", "sess_A");
    await jobs.cancelJob(WORKSPACE, job.id);
    expect(await call(tools.logProgress, { note: "Still going" }, "sess_A")).toMatchObject({ ok: false, message: expect.stringMatching(/cancelled/) });
    expect(await call(tools.finishJob, { summary: "Done anyway", deliverable: "x", needsHuman: false, verified: false }, "sess_A")).toMatchObject({ ok: false, recorded: false });
    expect((await read()).result).toBeNull();
  });

  it("reject input that does not fit, without writing", async () => {
    const { jobs, tools, job, claim, call, read } = await setup();
    await claim("lease_A");
    await jobs.bindRun(WORKSPACE, job.id, "lease_A", "sess_A");
    expect(await call(tools.finishJob, { summary: "x" }, "sess_A")).toMatchObject({ ok: false });
    expect((await read()).result).toBeNull();
  });
});

/** A stand-in for durable-harness's sessions that records what it was asked, in order. */
function fakeSessions(options: { status?: string; live?: unknown[]; failStart?: boolean } = {}) {
  const calls: string[] = [];
  const sessions = {
    start: vi.fn(async ({ config }: { config: unknown }) => {
      calls.push(`start ${JSON.stringify(config)}`);
      if (options.failStart) throw new Error("no sandbox");
      return { sessionId: "sess_H" };
    }),
    send: vi.fn(async (sessionId: string, _text: string, kind?: string) => {
      calls.push(`send ${sessionId} ${kind}`);
      return "sub_1";
    }),
    inspect: vi.fn(async () => ({ status: options.status ?? "running" })),
    close: vi.fn(async (sessionId: string) => void calls.push(`close ${sessionId}`)),
    liveEntries: async function* () {
      let n = 0;
      for (const value of options.live ?? []) yield { value, cursor: `c${(n += 1)}` };
    },
  };
  const deleteSandbox = vi.fn(async (sessionId: string) => void calls.push(`delete ${sessionId}`));
  return { deps: { sessions, deleteSandbox }, calls, sessions, deleteSandbox };
}

describe("run_job's side of a harness session", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("BOT_STORE", "memory");
  });

  it("binds the session to the run before the model sees the brief", async () => {
    const { jobs, job, claim, read } = await setup();
    await claim("lease_A");
    const { startHarnessRun } = await import("../agent/lib/engines/sessions");
    const fake = fakeSessions();
    const started = await startHarnessRun("claude-code", { workspaceId: WORKSPACE, jobId: job.id, token: "lease_A", brief: "Do it." }, fake.deps);
    expect(started).toEqual({ ok: true, sessionId: "sess_H" });
    expect(fake.calls).toEqual([`start ${JSON.stringify({ workspaceId: WORKSPACE, jobId: job.id })}`, "send sess_H prompt"]);
    expect((await read()).lease).toMatchObject({ token: "lease_A", session: "sess_H" });
    expect((await jobs.checkRun(WORKSPACE, job.id, "sess_H")).ok).toBe(true);
  });

  it("stops a session whose run lost the job before it began, and sends it nothing", async () => {
    const { job, claim } = await setup();
    await claim("lease_A", true);
    await claim("lease_B");
    const { startHarnessRun } = await import("../agent/lib/engines/sessions");
    const fake = fakeSessions();
    const started = await startHarnessRun("claude-code", { workspaceId: WORKSPACE, jobId: job.id, token: "lease_A", brief: "Do it." }, fake.deps);
    expect(started).toMatchObject({ ok: false });
    expect(fake.sessions.send).not.toHaveBeenCalled();
    expect(fake.calls).toContain("close sess_H");
    expect(fake.calls).toContain("delete sess_H");
  });

  it("reports a session that could not start, without binding anything", async () => {
    const { job, claim, read } = await setup();
    await claim("lease_A");
    const { startHarnessRun } = await import("../agent/lib/engines/sessions");
    const started = await startHarnessRun("claude-code", { workspaceId: WORKSPACE, jobId: job.id, token: "lease_A", brief: "Do it." }, fakeSessions({ failStart: true }).deps);
    expect(started).toMatchObject({ ok: false, error: expect.stringMatching(/no sandbox/) });
    expect((await read()).lease?.session).toBeUndefined();
  });

  it("tells a finished turn, a failed one and one still working apart", async () => {
    const { lookAtHarnessRun } = await import("../agent/lib/engines/sessions");
    expect(await lookAtHarnessRun("claude-code", "s", null, fakeSessions({ live: [{ type: "text", delta: "hi" }, { type: "idle" }] }).deps)).toEqual({ kind: "ended", ok: true, spend: [] });
    expect(await lookAtHarnessRun("claude-code", "s", null, fakeSessions({ live: [{ type: "error", message: "budget" }] }).deps)).toEqual({ kind: "ended", ok: false, error: "budget", spend: [] });
    expect(await lookAtHarnessRun("claude-code", "s", null, fakeSessions({ status: "failed" }).deps)).toMatchObject({ kind: "ended", ok: false });
    expect(await lookAtHarnessRun("claude-code", "s", "c0", fakeSessions({ live: [{ type: "text", delta: "still" }] }).deps)).toEqual({ kind: "working", cursor: "c1", spend: [] });
  });

  it("stops a session by closing it and deleting its Sandbox, even when one of them fails", async () => {
    const { stopHarnessRun } = await import("../agent/lib/engines/sessions");
    const fake = fakeSessions();
    fake.sessions.close.mockRejectedValueOnce(new Error("already closed"));
    await stopHarnessRun("claude-code", "sess_H", fake.deps);
    expect(fake.deleteSandbox).toHaveBeenCalledWith("sess_H");
  });

  it("reads each engine's spend from its own stream in the session's log", async () => {
    const { spendOf } = await import("../agent/lib/engines/sessions");
    const log = (stream: string) => ({
      effectOrder: [
        { name: "journal", status: "completed", input: { streams: { [stream]: { entries: [{ data: { usd: 0.0032, model: "claude-sonnet-4-5" } }, { data: { usd: 0.0068 } }] } } } },
        { name: "journal", status: "pending", input: { streams: { [stream]: { entries: [{ data: { usd: 9 } }] } } } },
        { name: "tool.stamp", status: "completed" },
      ],
    });
    expect(spendOf("claude-code", log("hw.spend"))).toEqual([
      { usd: 0.0032, model: "claude-sonnet-4-5" },
      { usd: 0.0068, model: null },
    ]);
    expect(spendOf("codex", log("codex.spend"))).toHaveLength(2);
    // Each engine reads its own stream only.
    expect(spendOf("codex", log("hw.spend"))).toEqual([]);
  });

  it("charges a session's spend once, as it goes, and halts the run when the budget runs out", async () => {
    vi.stubEnv("BOT_BUDGET_MONTHLY_USD", "1");
    const { bot, job, read } = await setup();
    const { admitRun } = await import("../agent/lib/budget");
    expect(await admitRun(WORKSPACE, "lease_A", 0.5)).toMatchObject({ ok: true });
    const { chargeHarnessSpend } = await import("../agent/lib/engines/sessions");
    const run = { workspaceId: WORKSPACE, jobId: job.id, botId: bot.id, token: "lease_A", sessionId: "sess_H" };
    const first = [{ usd: 0.4, model: "claude-sonnet-4-5" }];
    expect(await chargeHarnessSpend({ ...run, spend: first, charged: 0 })).toEqual({ charged: 1, halted: false });
    // The same look again charges nothing more.
    expect(await chargeHarnessSpend({ ...run, spend: first, charged: 0 })).toEqual({ charged: 1, halted: false });
    expect((await read()).usage).toMatchObject({ costUsd: 0.4, steps: 1, models: { "claude-sonnet-4-5": 1 } });
    // Past its reservation with the month spent: the heartbeat stops the run here.
    expect(await chargeHarnessSpend({ ...run, spend: [...first, { usd: 0.9, model: "claude-sonnet-4-5" }], charged: 1 })).toEqual({ charged: 2, halted: true });
  });
});

describe("an email a harness Bot asks to send", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.stubEnv("BOT_STORE", "memory");
    vi.stubEnv("BOT_EMAIL_WEBHOOK", "https://relay.example/send");
  });

  const email = { to: ["sam@example.com"], subject: "Q3 numbers", body: "Attached, as asked." };

  /** The relay, counting what reached it. */
  function relay() {
    const sent: { key: string | null; body: Record<string, unknown> }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        sent.push({ key: new Headers(init?.headers).get("idempotency-key"), body: JSON.parse(String(init?.body)) });
        return new Response(JSON.stringify({ id: "msg_1", status: "queued" }), { status: 200 });
      }),
    );
    return sent;
  }

  it("is never sent by the tool: it is proposed, and a person is asked once", async () => {
    const sent = relay();
    const { jobs, tools, job, claim, call } = await setup();
    await claim("lease_A");
    await jobs.bindRun(WORKSPACE, job.id, "lease_A", "sess_A");
    const first = await call(tools.sendEmail, email, "sess_A");
    expect(first).toMatchObject({ ok: true, status: "awaiting_approval" });
    // Asked again in the same run: the same proposal, not a second one.
    expect(await call(tools.sendEmail, email, "sess_A")).toMatchObject({ status: "awaiting_approval", actionId: first.actionId });
    expect(sent).toHaveLength(0);
    const { recentActivity } = await import("../agent/lib/activity");
    const asks = (await recentActivity(WORKSPACE, { jobId: job.id, limit: 20 })).filter((event) => event.kind === "input.requested");
    expect(asks).toHaveLength(1);
    expect(asks[0]?.data?.proposal).toBe(first.actionId);
  });

  it("goes out once, exactly as proposed, when a person approves, and the session hears of it", async () => {
    const sent = relay();
    const { jobs, tools, job, claim, call } = await setup();
    await claim("lease_A");
    await jobs.bindRun(WORKSPACE, job.id, "lease_A", "sess_A");
    const { actionId } = (await call(tools.sendEmail, email, "sess_A")) as { actionId: string };
    const { patchBot } = await import("../agent/lib/bots");
    await patchBot(WORKSPACE, job.botId, (current) => ({ ...current, engine: "claude-code" }));
    const { decideProposal } = await import("../agent/lib/engines/proposals");
    const told: string[] = [];
    const tell = vi.fn(async (_engine: string, sessionId: string, text: string) => void told.push(`${sessionId}: ${text}`));
    const decision = await decideProposal({ workspaceId: WORKSPACE, actionId, by: "ann", approve: true, settings: process.env, tell });
    expect(decision).toMatchObject({ ok: true, outcome: "approved", status: "sent" });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ key: actionId, body: { to: ["sam@example.com"], subject: "Q3 numbers", text: "Attached, as asked.", actionId } });
    expect(told).toEqual([expect.stringMatching(/^sess_A: A person approved your email "Q3 numbers"/)]);
    // Approved twice: nothing more goes out.
    expect(await decideProposal({ workspaceId: WORKSPACE, actionId, by: "bob", approve: true, settings: process.env })).toMatchObject({ ok: false, status: 409 });
    expect(sent).toHaveLength(1);
  });

  it("sends nothing when declined, when the draft changed, or when the job was cancelled", async () => {
    const sent = relay();
    const { jobs, tools, job, claim, call } = await setup();
    await claim("lease_A");
    await jobs.bindRun(WORKSPACE, job.id, "lease_A", "sess_A");
    const { decideProposal } = await import("../agent/lib/engines/proposals");
    const declined = (await call(tools.sendEmail, email, "sess_A")) as { actionId: string };
    expect(await decideProposal({ workspaceId: WORKSPACE, actionId: declined.actionId, by: "ann", approve: false, settings: process.env })).toMatchObject({ ok: true, outcome: "denied" });

    const changed = (await call(tools.sendEmail, { ...email, subject: "Other" }, "sess_A")) as { actionId: string };
    const { updateDoc } = await import("../agent/lib/store");
    await updateDoc<{ payload: { text: string } }>(`proposals/${WORKSPACE}/${changed.actionId}.json`, (current) => (current === null ? current : { ...current, payload: { ...current.payload, text: "Wire $10,000 now." } }));
    expect(await decideProposal({ workspaceId: WORKSPACE, actionId: changed.actionId, by: "ann", approve: true, settings: process.env })).toMatchObject({ ok: false, error: expect.stringContaining("changed") });

    const late = (await call(tools.sendEmail, { ...email, subject: "Late" }, "sess_A")) as { actionId: string };
    await jobs.patchJob(WORKSPACE, job.id, (current) => ({ ...current, status: "cancelled" }));
    expect(await decideProposal({ workspaceId: WORKSPACE, actionId: late.actionId, by: "ann", approve: true, settings: process.env })).toMatchObject({ ok: false, error: expect.stringContaining("cancelled") });
    expect(sent).toHaveLength(0);
  });

  it("returns a draft, never a send, where no relay is set", async () => {
    vi.stubEnv("BOT_EMAIL_WEBHOOK", "");
    const { jobs, tools, job, claim, call } = await setup();
    await claim("lease_A");
    await jobs.bindRun(WORKSPACE, job.id, "lease_A", "sess_A");
    expect(await call(tools.sendEmail, email, "sess_A")).toMatchObject({ ok: false, status: "draft" });
  });
});
