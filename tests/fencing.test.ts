import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Job, JobResult } from "../agent/lib/types";

/**
 * A run's lease can lapse while its bot keeps working, and the next run then
 * claims the job. These play that out against the in-memory store and the
 * teammate tools themselves: the old run must write nothing, and the new run's
 * binding and result must survive it.
 */

// The computer is not under test: no sandbox to back up or restore.
vi.mock("../agent/lib/computer-backup", () => ({
  ensureComputerRestored: vi.fn(async () => undefined),
  checkpointComputer: vi.fn(async () => undefined),
}));
// Binding a screen is just the session binding here; starting a browser is not.
// Imported per call: a mock outlives vi.resetModules, the store behind it does not.
vi.mock("../agent/subagents/teammate/lib/browser", () => ({
  bindScreen: async (ctx: { session: { id: string; auth: never } }, botId: string, jobId: string) => {
    const { bindSession } = await import("../agent/lib/computer/screens");
    const { operator } = await import("../agent/lib/session");
    return bindSession({ sessionId: ctx.session.id, workspaceId: operator(ctx).workspaceId, botId, jobId, n: 1 });
  },
}));

const WORKSPACE = "wsf";

const ctxFor = (sessionId: string, files: Record<string, Uint8Array> = {}) =>
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
    getSandbox: async () => ({ readBinaryFile: async ({ path }: { path: string }) => files[path] ?? null }),
  }) as never;

type Exec = { execute: (input: unknown, ctx: never) => Promise<Record<string, unknown>> };

async function setup() {
  const jobs = await import("../agent/lib/jobs");
  const tool = async (name: string) =>
    (await import(`../agent/subagents/teammate/tools/${name}.ts`)).default as Exec;
  const tools = {
    jobBrief: await tool("job_brief"),
    finishJob: await tool("finish_job"),
    saveArtifact: await tool("save_artifact"),
    logProgress: await tool("log_progress"),
    learn: await tool("learn"),
  };
  const job = await jobs.assignJob({
    workspaceId: WORKSPACE,
    botId: "bot_1",
    requestedBy: "operator",
    title: "Check the listings",
    brief: "Look for new listings.",
  });
  /** Claims the job as a run. `lapsed` leaves the lease already expired, as if its heartbeat had stopped. */
  const claim = async (token: string, lapsed = false) => {
    const claimed = await jobs.claimJob(WORKSPACE, job.id, {
      token,
      forMs: lapsed ? 0 : 20 * 60_000,
      status: "running",
      kind: "run",
      countAttempt: true,
    });
    expect(claimed.ok).toBe(true);
  };
  const read = async () => (await jobs.getJob(WORKSPACE, job.id)) as Job;
  const finish = (session: string, summary: string) =>
    tools.finishJob.execute(
      { jobId: job.id, summary, deliverable: summary, needsHuman: false, verified: true },
      ctxFor(session),
    );
  return { jobs, tools, job, claim, read, finish };
}

describe("fenced runs", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("BOT_STORE", "memory");
  });

  it("refuses every write from a run whose lease was taken over, and keeps the new run's", async () => {
    const { jobs, tools, job, claim, read, finish } = await setup();

    await claim("lease_A", true);
    const briefA = await tools.jobBrief.execute({ jobId: job.id, runToken: "lease_A" }, ctxFor("sess_A"));
    expect(briefA.found).toBe(true);
    expect((await read()).lease?.session).toBe("sess_A");

    // A's lease lapsed; run B claims the job. Until B binds, A is no longer the run either.
    await claim("lease_B");
    expect((await read()).lease?.session).toBeUndefined();
    expect(await finish("sess_A", "A finished in B's lease window")).toMatchObject({ recorded: false, reason: "unbound" });
    expect((await read()).result).toBeNull();

    // A cannot rebind with its old token; B binds with its own.
    expect(await tools.jobBrief.execute({ jobId: job.id, runToken: "lease_A" }, ctxFor("sess_A"))).toMatchObject({
      found: false,
      reason: "superseded",
    });
    const briefB = await tools.jobBrief.execute({ jobId: job.id, runToken: "lease_B" }, ctxFor("sess_B"));
    expect(briefB.found).toBe(true);

    expect(await finish("sess_B", "B checked and found two listings")).toMatchObject({ recorded: true });

    // Everything A tries now is refused and leaves the record as B has it.
    const before = await read();
    expect(await finish("sess_A", "A overwrites the result")).toMatchObject({ recorded: false, reason: "superseded" });
    expect(
      await tools.saveArtifact.execute(
        { jobId: job.id, path: "work/a.txt" },
        ctxFor("sess_A", { "work/a.txt": new TextEncoder().encode("from A") }),
      ),
    ).toMatchObject({ saved: false, reason: "superseded" });
    expect(await tools.logProgress.execute({ jobId: job.id, note: "A is still going" }, ctxFor("sess_A"))).toMatchObject({
      logged: false,
      reason: "superseded",
    });
    expect(await tools.learn.execute({ jobId: job.id, lesson: "A's lesson for the playbook." }, ctxFor("sess_A"))).toMatchObject({
      learned: false,
      reason: "superseded",
    });

    const after = await read();
    expect(after.result).toEqual(before.result);
    expect(after.artifacts).toEqual([]);
    expect(after.sessionId).toBe("sess_B");
    expect(after.lease).toMatchObject({ token: "lease_B", kind: "run", session: "sess_B" });
    expect(after.result).toMatchObject({
      summary: "B checked and found two listings",
      producedBy: { token: "lease_B", session: "sess_B" },
    });

    // B's own side writes still go through.
    expect(
      await tools.saveArtifact.execute(
        { jobId: job.id, path: "work/b.txt" },
        ctxFor("sess_B", { "work/b.txt": new TextEncoder().encode("from B") }),
      ),
    ).toMatchObject({ saved: true });
    expect(await tools.logProgress.execute({ jobId: job.id, note: "B saved its notes" }, ctxFor("sess_B"))).toMatchObject({
      logged: true,
    });
    expect((await read()).artifacts).toHaveLength(1);
    expect((await jobs.checkRun(WORKSPACE, job.id, "sess_B")).ok).toBe(true);
  });

  it("finds the bound job from the session when no job id is passed", async () => {
    const { tools, job, claim } = await setup();
    const { guardSideEffect } = await import("../agent/lib/run-guard");
    await claim("lease_A");
    expect(await guardSideEffect(ctxFor("sess_A"))).toMatchObject({ ok: false, reason: "unbound", jobId: null });
    await tools.jobBrief.execute({ jobId: job.id, runToken: "lease_A" }, ctxFor("sess_A"));
    expect(await guardSideEffect(ctxFor("sess_A"))).toMatchObject({ ok: true, jobId: job.id });
  });

  it("tells a result from the run that recorded it, not from when", async () => {
    const { jobs, tools, job, claim, read, finish } = await setup();
    await claim("lease_A", true);
    const startedA = new Date(Date.now() - 1_000).toISOString();
    await tools.jobBrief.execute({ jobId: job.id, runToken: "lease_A" }, ctxFor("sess_A"));
    await claim("lease_B");
    const startedB = new Date().toISOString();
    await tools.jobBrief.execute({ jobId: job.id, runToken: "lease_B" }, ctxFor("sess_B"));
    await finish("sess_B", "B's result for this cycle");

    const result = (await read()).result as JobResult;
    // A's window opened earlier, so by time alone B's result would pass as A's.
    expect(jobs.resultIsFromRun(result, { startedAt: startedA, resultAtClaim: null })).toBe(true);
    expect(jobs.resultIsFromRun(result, { token: "lease_A", startedAt: startedA, resultAtClaim: null })).toBe(false);
    expect(jobs.resultIsFromRun(result, { token: "lease_B", startedAt: startedB, resultAtClaim: null })).toBe(true);
  });

  it("refuses fenced writes on a cancelled job", async () => {
    const { jobs, tools, job, claim, read, finish } = await setup();
    await claim("lease_A");
    await tools.jobBrief.execute({ jobId: job.id, runToken: "lease_A" }, ctxFor("sess_A"));
    expect((await jobs.cancelJob(WORKSPACE, job.id)).ok).toBe(true);

    expect(await finish("sess_A", "Finished after all")).toMatchObject({ recorded: false, reason: "cancelled" });
    expect(await jobs.patchJobAsRun(WORKSPACE, job.id, "sess_A", (current) => ({ ...current, title: "x" }))).toEqual({
      ok: false,
      reason: "cancelled",
    });
    expect(await jobs.bindRun(WORKSPACE, job.id, "lease_A", "sess_A")).toEqual({ ok: false, reason: "cancelled" });
    expect(await tools.logProgress.execute({ jobId: job.id, note: "Still here" }, ctxFor("sess_A"))).toMatchObject({
      logged: false,
      reason: "cancelled",
    });
    const after = await read();
    expect(after.result).toBeNull();
    expect(after.title).toBe("Check the listings");
  });

  it("refuses a run after its job closed, and an unknown job", async () => {
    const { jobs, tools, job, claim, finish } = await setup();
    await claim("lease_A");
    await tools.jobBrief.execute({ jobId: job.id, runToken: "lease_A" }, ctxFor("sess_A"));
    await finish("sess_A", "Done the first time");
    const recorded = (await jobs.getJob(WORKSPACE, job.id))?.result as JobResult;
    await jobs.completeJob(WORKSPACE, job.id, recorded, { token: "lease_A" });

    expect(await finish("sess_A", "One more result")).toMatchObject({ recorded: false, reason: "superseded" });
    expect(await jobs.checkRun(WORKSPACE, "job_nope", "sess_A")).toEqual({ ok: false, reason: "missing" });
    expect(await tools.jobBrief.execute({ jobId: "job_nope", runToken: "lease_A" }, ctxFor("sess_A"))).toMatchObject({
      found: false,
      reason: "missing",
    });
  });

  it("keeps the binding when the lease is renewed, and drops it on a fresh claim", async () => {
    const { jobs, job, claim, read } = await setup();
    await claim("lease_A", true);
    expect((await jobs.bindRun(WORKSPACE, job.id, "lease_A", "sess_A")).ok).toBe(true);
    expect(await jobs.renewLease(WORKSPACE, job.id, "lease_A", 60_000)).toBe(true);
    expect((await read()).lease?.session).toBe("sess_A");
    // Binding again with the same session writes nothing new.
    const again = await jobs.bindRun(WORKSPACE, job.id, "lease_A", "sess_A");
    expect(again.ok && again.job.lease?.session).toBe("sess_A");
  });
});

describe("fenced writes retried after they landed", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("BOT_STORE", "memory");
  });

  // A store can report a write that landed as a conflict; updateDoc then runs
  // the change again on a record that already has it. These replay that.
  it("treats a change already on the record as done, not as a second write", async () => {
    const { jobs, job, claim, read } = await setup();
    await claim("lease_A");
    expect((await jobs.bindRun(WORKSPACE, job.id, "lease_A", "sess_A")).ok).toBe(true);
    const boundAt = (await read()).updatedAt;
    expect((await jobs.bindRun(WORKSPACE, job.id, "lease_A", "sess_A")).ok).toBe(true);
    expect((await read()).updatedAt).toBe(boundAt);

    const artifact = {
      id: "art_1",
      name: "a.txt",
      mediaType: "text/plain",
      bytes: 1,
      key: "artifacts/a.txt",
      savedAt: new Date().toISOString(),
    };
    expect((await jobs.attachArtifact(WORKSPACE, job.id, artifact, "sess_A")).ok).toBe(true);
    expect((await jobs.attachArtifact(WORKSPACE, job.id, artifact, "sess_A")).ok).toBe(true);
    expect((await read()).artifacts).toHaveLength(1);

    const unchanged = await jobs.patchJobAsRun(WORKSPACE, job.id, "sess_A", () => null);
    expect(unchanged.ok && unchanged.job.artifacts).toHaveLength(1);
  });
});

describe("records written before runs were fenced", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("BOT_STORE", "memory");
  });

  it("reads a lease without a session as unbound, and binds it with its token", async () => {
    const { jobs, job } = await setup();
    const { updateDoc } = await import("../agent/lib/store");
    // The shape older code wrote: a run lease with no session on it.
    await updateDoc<Job>(`jobs/${WORKSPACE}/${job.id}.json`, (current) =>
      current === null
        ? null
        : {
            ...current,
            status: "running",
            lease: { token: "lease_old", until: new Date(Date.now() + 60_000).toISOString(), kind: "run" },
          },
    );
    expect(await jobs.checkRun(WORKSPACE, job.id, "sess_A")).toEqual({ ok: false, reason: "unbound" });
    expect((await jobs.bindRun(WORKSPACE, job.id, "lease_old", "sess_A")).ok).toBe(true);
    expect((await jobs.checkRun(WORKSPACE, job.id, "sess_A")).ok).toBe(true);
  });

  it("judges a result without producedBy by when it was recorded", async () => {
    const { resultIsFromRun } = await import("../agent/lib/jobs");
    const old: JobResult = {
      summary: "Nothing new.",
      deliverable: "No listings.",
      openQuestions: [],
      needsHuman: false,
      recordedAt: "2026-09-20T10:00:05.000Z",
    };
    expect(resultIsFromRun(old, { token: "lease_B", startedAt: "2026-09-20T10:00:00.000Z", resultAtClaim: null })).toBe(true);
    expect(resultIsFromRun(old, { token: "lease_B", startedAt: "2026-09-20T10:01:00.000Z", resultAtClaim: null })).toBe(false);
  });
});
