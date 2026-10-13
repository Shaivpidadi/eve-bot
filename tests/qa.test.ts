import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Job } from "../agent/lib/types";

/**
 * `crashRun` makes a job look as the store sees it after the process running
 * it died: the lease is lapsed and nobody's, the bound session is gone, the
 * status is untouched. The old run must then find itself superseded, and the
 * watchdog must find the job due.
 */

const WORKSPACE = "default";

async function claimed() {
  const jobs = await import("../agent/lib/jobs");
  const qa = await import("../agent/lib/qa");
  const job = await jobs.assignJob({
    workspaceId: WORKSPACE,
    botId: "bot_1",
    requestedBy: "operator",
    title: "Watch the listings",
    brief: "Look for new listings.",
  });
  const claim = await jobs.claimJob(WORKSPACE, job.id, { token: "lease_A", forMs: 20 * 60_000, status: "running", kind: "run", countAttempt: true });
  expect(claim.ok).toBe(true);
  expect((await jobs.bindRun(WORKSPACE, job.id, "lease_A", "sess_A")).ok).toBe(true);
  const read = async () => (await jobs.getJob(WORKSPACE, job.id)) as Job;
  return { jobs, qa, job, read };
}

describe("crashRun", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("BOT_STORE", "memory");
  });

  it("lapses the lease, drops the session, and leaves the status alone", async () => {
    const { jobs, qa, job, read } = await claimed();
    const crashed = await qa.crashRun(WORKSPACE, job.id);
    expect(crashed).toMatchObject({ ok: true, token: "lease_A", sessions: ["sess_A"] });

    const after = await read();
    expect(after.status).toBe("running");
    expect(after.lease).toMatchObject({ kind: "run", token: "dead_lease_A" });
    expect(after.lease?.session).toBeUndefined();
    expect(Date.parse(after.lease?.until ?? "")).toBeLessThan(Date.now());

    // The old run is nobody now: its heartbeat stops it, its session's writes are refused.
    expect(jobs.standingOf(after, "lease_A")).toBe("superseded");
    expect(jobs.runCheckOf(after, "sess_A")).toMatchObject({ ok: false, reason: "unbound" });
  });

  it("is what the watchdog picks up: the job is due and a dispatch claim wins", async () => {
    const { jobs, qa, job } = await claimed();
    expect((await jobs.dueJobs(10)).map((due) => due.id)).not.toContain(job.id);
    await qa.crashRun(WORKSPACE, job.id);
    expect((await jobs.dueJobs(10)).map((due) => due.id)).toContain(job.id);
    const dispatched = await jobs.claimJob(WORKSPACE, job.id, { token: "dispatch_1", forMs: 60_000, status: "dispatched", kind: "dispatch" });
    expect(dispatched.ok).toBe(true);
  });

  it("records the crash once and treats a second ask as the same crash", async () => {
    const { qa, job, read } = await claimed();
    const { recentActivity } = await import("../agent/lib/activity");
    expect((await qa.crashRun(WORKSPACE, job.id)).ok).toBe(true);
    const again = await qa.crashRun(WORKSPACE, job.id);
    expect(again).toMatchObject({ ok: true, token: "lease_A", sessions: [] });
    expect((await read()).lease?.token).toBe("dead_lease_A");
    const crashes = (await recentActivity(WORKSPACE, { jobId: job.id })).filter((event) => event.kind === "job.crashed");
    expect(crashes).toHaveLength(1);
    expect(crashes[0]?.jobId).toBe(job.id);
  });

  it("refuses a job nothing holds", async () => {
    const jobs = await import("../agent/lib/jobs");
    const qa = await import("../agent/lib/qa");
    const job = await jobs.assignJob({ workspaceId: WORKSPACE, botId: "bot_1", requestedBy: "operator", title: "Idle", brief: "Nothing." });
    expect(await qa.crashRun(WORKSPACE, job.id)).toMatchObject({ ok: false });
    expect(await qa.crashRun(WORKSPACE, "job_missing")).toMatchObject({ ok: false });
  });

  it("is off unless the deployment opts in", async () => {
    const { qaEnabled } = await import("../agent/lib/qa");
    expect(qaEnabled({})).toBe(false);
    expect(qaEnabled({ BOT_QA: "1" })).toBe(true);
    expect(qaEnabled({ BOT_QA: "true" })).toBe(false);
  });
});
