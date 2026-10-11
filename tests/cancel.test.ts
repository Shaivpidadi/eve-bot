import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Job, JobResult } from "../agent/lib/types";

/**
 * Cancelling a job is one path for every caller (lib/cancel.ts): the job is
 * cancelled durably, the run's bound session is interrupted when the caller can
 * reach it, and the cancelled record holds against everything the old run
 * still tries. eve's session handle is mocked; the store is the in-memory one.
 */

vi.mock("../agent/lib/computer-backup", () => ({
  ensureComputerRestored: vi.fn(async () => undefined),
  checkpointComputer: vi.fn(async () => undefined),
}));
vi.mock("../agent/subagents/teammate/lib/browser", () => ({
  bindScreen: async (ctx: { session: { id: string; auth: never } }, botId: string, jobId: string) => {
    const { bindSession } = await import("../agent/lib/computer/screens");
    const { operator } = await import("../agent/lib/session");
    return bindSession({ sessionId: ctx.session.id, workspaceId: operator(ctx).workspaceId, botId, jobId, n: 1 });
  },
}));

const WORKSPACE = "default";

const ctxFor = (sessionId: string) =>
  ({
    session: {
      id: sessionId,
      auth: {
        current: {
          principalId: "runtime",
          principalType: "runtime",
          authenticator: "test",
          attributes: { workspaceId: WORKSPACE, room: "desk" },
        },
        initiator: null,
      },
      turn: { id: "t", sequence: 1 },
    },
    abortSignal: new AbortController().signal,
  }) as never;

type Exec = { execute: (input: unknown, ctx: never) => Promise<Record<string, unknown>> };

const RESULT: JobResult = { summary: "Done.", deliverable: "Done.", openQuestions: [], needsHuman: false };

/** A job claimed by run `lease_A` and bound to teammate session `sess_A`, as if mid-work. */
async function running() {
  const jobs = await import("../agent/lib/jobs");
  const cancel = await import("../agent/lib/cancel");
  const tool = async (name: string) =>
    (await (name === "cancel_job"
      ? import("../agent/tools/cancel_job")
      : import(`../agent/subagents/teammate/tools/${name}.ts`))).default as unknown as Exec;
  const job = await jobs.assignJob({
    workspaceId: WORKSPACE,
    botId: "bot_1",
    requestedBy: "operator",
    title: "Watch the listings",
    brief: "Look for new listings.",
  });
  const claimed = await jobs.claimJob(WORKSPACE, job.id, {
    token: "lease_A",
    forMs: 20 * 60_000,
    status: "running",
    kind: "run",
    countAttempt: true,
  });
  expect(claimed.ok).toBe(true);
  const jobBrief = await tool("job_brief");
  expect((await jobBrief.execute({ jobId: job.id, runToken: "lease_A" }, ctxFor("sess_A"))).found).toBe(true);
  const read = async () => (await jobs.getJob(WORKSPACE, job.id)) as Job;
  return { jobs, cancel, tool, job, read };
}

/** A stand-in for eve's `attachSession`, recording what was asked of which session. */
function fakeSessions(fail?: { cancel?: Error; reset?: Error; hang?: boolean }) {
  const calls: string[] = [];
  const attachSession = vi.fn((id: string) => ({
    cancel: async (options: { tasks: boolean }) => {
      calls.push(`cancel ${id} tasks=${options.tasks}`);
      if (fail?.hang) return new Promise(() => undefined);
      if (fail?.cancel) throw fail.cancel;
      return { status: "accepted" };
    },
    reset: async (options: { reason?: string }) => {
      calls.push(`reset ${id} ${options.reason ?? ""}`.trim());
      if (fail?.reset) throw fail.reset;
      return { status: "accepted" };
    },
  }));
  return { attachSession, calls };
}

describe("cancelJobRun", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("BOT_STORE", "memory");
  });

  it("cancels an active job durably and interrupts the run's bound session", async () => {
    const { cancel, job, read } = await running();
    const { attachSession, calls } = fakeSessions();

    const outcome = await cancel.cancelJobRun(WORKSPACE, job.id, {
      interrupt: cancel.interruptVia(attachSession, "Cancelled from the console"),
    });

    expect(outcome).toMatchObject({ ok: true, wasRunning: true, alreadyCancelled: false, session: "sess_A", interruption: "interrupted" });
    expect(calls).toEqual(["cancel sess_A tasks=true", "reset sess_A Cancelled from the console"]);
    const after = await read();
    expect(after.status).toBe("cancelled");
    expect(after.lease).toBeNull();
    expect(after.cancellation?.session).toBe("sess_A");
  });

  it("keeps the job cancelled and fenced when interrupting fails", async () => {
    const { cancel, jobs, tool, job, read } = await running();
    const { attachSession } = fakeSessions({ cancel: new Error("session busy"), reset: new Error("no answer") });

    const outcome = await cancel.cancelJobRun(WORKSPACE, job.id, { interrupt: cancel.interruptVia(attachSession, "x") });
    expect(outcome.ok && outcome.interruption).toBe("failed");
    expect(outcome.ok && outcome.interruptError).toContain("session busy");
    expect(outcome.ok && cancel.describeInterruption(outcome)).toContain("stays cancelled");
    expect((await read()).status).toBe("cancelled");

    // The bot is still running, but every guarded action it tries is refused.
    expect(await jobs.checkRun(WORKSPACE, job.id, "sess_A")).toEqual({ ok: false, reason: "cancelled" });
    const logProgress = await tool("log_progress");
    expect(await logProgress.execute({ jobId: job.id, note: "Still going" }, ctxFor("sess_A"))).toMatchObject({
      logged: false,
      reason: "cancelled",
    });
    const createBot = await tool("create_bot");
    const hired = await createBot.execute(
      { jobId: job.id, name: "Ava", role: "Researcher", persona: "Careful, thorough, cites every source." },
      ctxFor("sess_A"),
    );
    expect(hired).toMatchObject({ created: false });
    const { findBot } = await import("../agent/lib/bots");
    expect(await findBot(WORKSPACE, "Ava")).toBeNull();
  });

  it("gives up on a session that does not answer, within the bound", async () => {
    const { cancel, job, read } = await running();
    const { attachSession } = fakeSessions({ hang: true });
    const outcome = await cancel.cancelJobRun(WORKSPACE, job.id, { interrupt: cancel.interruptVia(attachSession, "x", 20) });
    expect(outcome.ok && outcome.interruption).toBe("failed");
    expect(outcome.ok && outcome.interruptError).toContain("timed out");
    expect((await read()).status).toBe("cancelled");
  });

  it("says when it could not reach the session at all, as from a tool", async () => {
    const { cancel, job, read } = await running();
    const outcome = await cancel.cancelJobRun(WORKSPACE, job.id);
    expect(outcome).toMatchObject({ ok: true, session: "sess_A", interruption: "unavailable" });
    expect((await read()).status).toBe("cancelled");
  });

  it("also stops the session the job records when the run has not bound one", async () => {
    const jobs = await import("../agent/lib/jobs");
    const cancel = await import("../agent/lib/cancel");
    const job = await jobs.assignJob({ workspaceId: WORKSPACE, botId: "bot_1", requestedBy: "op", title: "Watch", brief: "Watch." });
    const claimed = await jobs.claimJob(WORKSPACE, job.id, { token: "lease_A", forMs: 60_000, status: "running", kind: "run", countAttempt: true });
    expect(claimed.ok).toBe(true);
    // A lease from before runs were fenced: the session is on the job, not on the lease.
    await jobs.patchJob(WORKSPACE, job.id, (current) => ({ ...current, sessionId: "sess_legacy" }));
    expect((await jobs.getJob(WORKSPACE, job.id))?.lease?.session).toBeUndefined();
    const { attachSession, calls } = fakeSessions();

    const outcome = await cancel.cancelJobRun(WORKSPACE, job.id, { interrupt: cancel.interruptVia(attachSession, "x") });
    expect(outcome).toMatchObject({ ok: true, session: null, sessions: ["sess_legacy"], interruption: "interrupted" });
    expect(calls).toEqual(["cancel sess_legacy tasks=true", "reset sess_legacy x"]);
  });

  it("stops the run's bound session and the job's recorded one, each once", async () => {
    const { cancel, jobs, job } = await running();
    await jobs.patchJob(WORKSPACE, job.id, (current) => ({ ...current, sessionId: "sess_earlier" }));
    const { attachSession, calls } = fakeSessions();
    const outcome = await cancel.cancelJobRun(WORKSPACE, job.id, { interrupt: cancel.interruptVia(attachSession, "x") });
    expect(outcome).toMatchObject({ ok: true, session: "sess_A", sessions: ["sess_A", "sess_earlier"], interruption: "interrupted" });
    expect(calls.filter((call) => call.startsWith("cancel"))).toEqual(["cancel sess_A tasks=true", "cancel sess_earlier tasks=true"]);
    expect(cancel.sessionsToInterrupt("sess_A", { sessionId: "sess_A" })).toEqual(["sess_A"]);
    expect(cancel.sessionsToInterrupt(null, { sessionId: null })).toEqual([]);
  });

  it("does not interrupt a job nobody is working on", async () => {
    const jobs = await import("../agent/lib/jobs");
    const cancel = await import("../agent/lib/cancel");
    const job = await jobs.assignJob({ workspaceId: WORKSPACE, botId: "bot_1", requestedBy: "op", title: "Later", brief: "Later." });
    const { attachSession } = fakeSessions();
    const outcome = await cancel.cancelJobRun(WORKSPACE, job.id, { interrupt: cancel.interruptVia(attachSession, "x") });
    expect(outcome).toMatchObject({ ok: true, wasRunning: false, session: null, interruption: "no-session" });
    expect(attachSession).not.toHaveBeenCalled();
  });

  it("is idempotent: a second cancel succeeds, interrupts again, and records once", async () => {
    const { cancel, job } = await running();
    const { attachSession, calls } = fakeSessions();
    const interrupt = cancel.interruptVia(attachSession, "x");

    expect((await cancel.cancelJobRun(WORKSPACE, job.id, { interrupt })).ok).toBe(true);
    const again = await cancel.cancelJobRun(WORKSPACE, job.id, { interrupt });
    expect(again).toMatchObject({ ok: true, alreadyCancelled: true, session: "sess_A", interruption: "interrupted" });
    expect(calls.filter((call) => call.startsWith("cancel"))).toHaveLength(2);

    const { recentActivity } = await import("../agent/lib/activity");
    const events = await recentActivity(WORKSPACE, { jobId: job.id, limit: 50 });
    expect(events.filter((event) => event.kind === "job.cancelled")).toHaveLength(1);
  });

  it("treats its own write reported as a conflict as done, not as someone else's cancel", async () => {
    const { cancel, job, read } = await running();
    const { store, KvConflictError } = await import("../agent/lib/store");
    const kv = store();
    const put = kv.put.bind(kv);
    let tripped = false;
    // The Blob SDK can retry a write that landed and then report it as a conflict.
    vi.spyOn(kv, "put").mockImplementation(async (key, value, options) => {
      const version = await put(key, value, options);
      if (!tripped && key.startsWith("jobs/") && value.includes('"cancelled"')) {
        tripped = true;
        throw new KvConflictError(key);
      }
      return version;
    });

    const outcome = await cancel.cancelJobRun(WORKSPACE, job.id);
    expect(tripped).toBe(true);
    expect(outcome).toMatchObject({ ok: true, alreadyCancelled: false, wasRunning: true, session: "sess_A" });
    expect((await read()).status).toBe("cancelled");
  });

  it("still refuses a finished job", async () => {
    const { cancel, jobs, job } = await running();
    await jobs.completeJob(WORKSPACE, job.id, RESULT, { token: "lease_A" });
    expect(await cancel.cancelJobRun(WORKSPACE, job.id)).toEqual({ ok: false, reason: "That job is already finished." });
  });
});

describe("a cancelled job against its old run", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("BOT_STORE", "memory");
  });

  it("cannot be completed, held for sign-off, blocked, sent back, failed or renewed", async () => {
    const { cancel, jobs, job, read } = await running();
    await cancel.cancelJobRun(WORKSPACE, job.id);
    const cancelledAt = (await read()).updatedAt;

    const completed = await jobs.completeJob(WORKSPACE, job.id, RESULT, { token: "lease_A" });
    expect(completed?.status).toBe("cancelled");
    expect(await jobs.holdForSignoff(WORKSPACE, job.id, { token: "lease_A", forMs: 60_000, result: RESULT })).toBeNull();
    expect(await jobs.blockJob(WORKSPACE, job.id, "Need a hand", { token: "lease_A", result: RESULT })).toBeNull();
    expect(await jobs.sendBack(WORKSPACE, job.id, "Redo it", { token: "lease_A", result: RESULT })).toBeNull();
    expect(await jobs.failJob(WORKSPACE, job.id, "Broke", { token: "lease_A" })).toBeNull();
    expect(await jobs.renewLease(WORKSPACE, job.id, "lease_A", 60_000)).toBe(false);
    expect(await jobs.runStanding(WORKSPACE, job.id, "lease_A")).toBe("cancelled");

    const after = await read();
    expect(after.status).toBe("cancelled");
    expect(after.result).toBeNull();
    expect(after.updatedAt).toBe(cancelledAt);
    // And nothing can start it again.
    const reclaim = await jobs.claimJob(WORKSPACE, job.id, { token: "lease_B", forMs: 60_000, status: "running", kind: "run" });
    expect(reclaim).toEqual({ ok: false, reason: "That job was cancelled." });
  });

  it("tells the parent its run is over by standing, not just by a failed renewal", async () => {
    const { jobs, job } = await running();
    expect(await jobs.runStanding(WORKSPACE, job.id, "lease_A")).toBe("owns");
    expect(await jobs.runStanding(WORKSPACE, job.id, "lease_other")).toBe("superseded");
    expect(await jobs.runStanding(WORKSPACE, "job_nope", "lease_A")).toBe("missing");
  });
});

describe("the cancel_job tool and the console's DELETE route", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("BOT_STORE", "memory");
    vi.stubEnv("BOT_CONSOLE_TOKEN", "");
    vi.stubEnv("BOT_CONSOLE_TOKENS", "");
  });

  it("cancel_job cancels through the shared path and promises only what holds", async () => {
    const { tool, job, read } = await running();
    const cancelJob = await tool("cancel_job");
    const answer = await cancelJob.execute({ jobId: job.id }, ctxFor("sess_hq"));
    expect(answer).toMatchObject({ cancelled: true, interruption: "unavailable" });
    expect(String(answer.note)).toContain("every action it tries is refused");
    expect(String(answer.note)).toContain("no further model call");
    expect(String(answer.note)).toContain("next check");
    expect(String(answer.note)).not.toContain("may finish its current step");
    expect((await read()).status).toBe("cancelled");
    expect(await cancelJob.execute({ jobId: job.id }, ctxFor("sess_hq"))).toMatchObject({ cancelled: true, alreadyCancelled: true });
  });

  /** A job in HQ's room claimed by a run that never called job_brief, its session recorded only on the job. */
  async function unboundRun() {
    const jobs = await import("../agent/lib/jobs");
    const job = await jobs.assignJob({ workspaceId: WORKSPACE, botId: "bot_1", requestedBy: "op", title: "Draft", brief: "Draft it.", room: "desk" });
    const claimed = await jobs.claimJob(WORKSPACE, job.id, { token: "lease_A", forMs: 60_000, status: "running", kind: "run", countAttempt: true });
    expect(claimed.ok).toBe(true);
    await jobs.patchJob(WORKSPACE, job.id, (current) => ({ ...current, sessionId: "sess_unbound" }));
    return { jobs, job };
  }

  type Route = { method: string; path: string; handler: (request: Request, args: unknown) => Promise<Response> };
  const routeOf = async (method: string, path: string): Promise<Route> => {
    const ops = (await import("../agent/channels/ops")).default as unknown as { routes: Route[] };
    const route = ops.routes.find((candidate) => candidate.method === method && candidate.path === path);
    expect(route).toBeDefined();
    return route!;
  };

  it("starting a room over stops a job's session even when its run never bound it", async () => {
    const { jobs, job } = await unboundRun();
    const route = await routeOf("POST", "/bot/v1/rooms/:room/reset");
    const { attachSession, calls } = fakeSessions();
    const response = await route.handler(new Request("http://localhost/bot/v1/rooms/desk/reset", { method: "POST" }), {
      attachSession,
      params: { room: "desk" },
      resolveSession: async () => undefined,
      from: () => ({ reset: async () => undefined }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ cancelledJobs: [job.id] });
    expect(calls).toContain("cancel sess_unbound tasks=true");
    expect(calls).toContain("reset sess_unbound Room reset");
    expect((await jobs.getJob(WORKSPACE, job.id))?.status).toBe("cancelled");
  });

  it("DELETE /bot/v1/jobs/:jobId stops a session its run never bound", async () => {
    const { job } = await unboundRun();
    const route = await routeOf("DELETE", "/bot/v1/jobs/:jobId");
    const { attachSession, calls } = fakeSessions();
    const response = await route.handler(new Request(`http://localhost/bot/v1/jobs/${job.id}`, { method: "DELETE" }), {
      attachSession,
      params: { jobId: job.id },
    });
    expect(await response.json()).toMatchObject({ cancelled: true, interruption: "interrupted" });
    expect(calls).toEqual(["cancel sess_unbound tasks=true", expect.stringMatching(/^reset sess_unbound /)]);
  });

  it("DELETE /bot/v1/jobs/:jobId cancels and stops the bound session", async () => {
    const { job, read } = await running();
    const ops = (await import("../agent/channels/ops")).default as unknown as {
      routes: { method: string; path: string; handler: (request: Request, args: unknown) => Promise<Response> }[];
    };
    const route = ops.routes.find((candidate) => candidate.method === "DELETE" && candidate.path === "/bot/v1/jobs/:jobId");
    expect(route).toBeDefined();
    const { attachSession, calls } = fakeSessions();

    const response = await route!.handler(new Request(`http://localhost/bot/v1/jobs/${job.id}`, { method: "DELETE" }), {
      attachSession,
      params: { jobId: job.id },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ cancelled: true, interruption: "interrupted", alreadyCancelled: false });
    expect(calls[0]).toBe("cancel sess_A tasks=true");
    expect((await read()).status).toBe("cancelled");
  });
});
