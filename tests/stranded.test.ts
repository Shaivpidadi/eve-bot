import { beforeEach, describe, expect, it, vi } from "vitest";

import type { JobLease } from "../agent/lib/types";

/**
 * A lease held by another build on a local Workflow world is held by nobody:
 * the job is due at once, a dispatch claim wins it, and the feed says why.
 * On Vercel the other deployment keeps its run alive, so the clock rules.
 */

const WORKSPACE = "default";
const lease = (over: Partial<JobLease> = {}): JobLease => ({
  token: "run_1",
  kind: "run",
  until: new Date(Date.now() + 60_000).toISOString(),
  build: "build-A",
  ...over,
});

describe("leaseIsLive", () => {
  it("judges a lease by the clock, and by the build on a local world", async () => {
    const { leaseIsLive, leaseStranded } = await import("../agent/lib/jobs");
    const now = Date.now();
    for (const kind of ["run", "wait", "dispatch", "signoff"] as const) {
      // Same build: the clock.
      expect(leaseIsLive(lease({ kind }), now, { build: "build-A", local: true })).toBe(true);
      expect(leaseIsLive(lease({ kind, until: new Date(now - 1).toISOString() }), now, { build: "build-A", local: true })).toBe(false);
      // Another build, local world: dead at once.
      expect(leaseIsLive(lease({ kind }), now, { build: "build-B", local: true })).toBe(false);
      expect(leaseStranded(lease({ kind }), { build: "build-B", local: true })).toBe(true);
      // Another build, Vercel: still the clock.
      expect(leaseIsLive(lease({ kind }), now, { build: "build-B", local: false })).toBe(true);
      expect(leaseStranded(lease({ kind }), { build: "build-B", local: false })).toBe(false);
      // Unknown build (an older record): the clock.
      expect(leaseIsLive(lease({ kind, build: undefined }), now, { build: "build-B", local: true })).toBe(true);
    }
    expect(leaseIsLive(null, now)).toBe(false);
  });
});

describe("worldIsLocal", () => {
  it("is false on Vercel or with a shared world named", async () => {
    const { worldIsLocal } = await import("../agent/lib/world");
    expect(worldIsLocal({})).toBe(true);
    expect(worldIsLocal({ VERCEL: "1" })).toBe(false);
    expect(worldIsLocal({ BOT_WORKFLOW_WORLD: "@workflow/world-postgres" })).toBe(false);
    expect(worldIsLocal({ BOT_WORKFLOW_WORLD: "  " })).toBe(true);
  });
});

async function running() {
  const jobs = await import("../agent/lib/jobs");
  const bots = await import("../agent/lib/bots");
  const bot = await bots.hireBot({ workspaceId: WORKSPACE, hiredBy: "operator", name: "Atlas", role: "Generalist", persona: "Careful and brief." });
  const job = await jobs.assignJob({ workspaceId: WORKSPACE, botId: bot.id, requestedBy: "operator", title: "Watch the listings", brief: "Look." });
  const claim = await jobs.claimJob(WORKSPACE, job.id, { token: "run_1", forMs: 20 * 60_000, status: "running", kind: "run" });
  expect(claim.ok).toBe(true);
  return { jobs, bot, job };
}

describe("a job stranded by a rebuild", () => {
  beforeEach(async () => {
    // The override is the process's (every bundled copy of the module reads it), so a module reset alone keeps it.
    (await import("../agent/lib/build")).resetBuildId();
    vi.resetModules();
    vi.stubEnv("BOT_STORE", "memory");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("BOT_WORKFLOW_WORLD", "");
    vi.stubEnv("BOT_BUILD_ID", "build-A");
  });

  it("is due as soon as new code starts, and a dispatch claim wins it", async () => {
    const { jobs, job } = await running();
    const { overrideBuildId } = await import("../agent/lib/build");
    expect((await jobs.dueJobs(10)).map((due) => due.id)).not.toContain(job.id);
    overrideBuildId("build-B");
    expect((await jobs.dueJobs(10)).map((due) => due.id)).toContain(job.id);
    const claimed = await jobs.claimJob(WORKSPACE, job.id, { token: "dispatch_1", forMs: 60_000, status: "dispatched", kind: "dispatch" });
    expect(claimed.ok && claimed.job.lease).toMatchObject({ kind: "dispatch", build: "build-B" });
  });

  it("stays its run's on Vercel, where the old deployment keeps it alive", async () => {
    vi.stubEnv("VERCEL", "1");
    const { jobs, job } = await running();
    const { overrideBuildId } = await import("../agent/lib/build");
    overrideBuildId("build-B");
    expect((await jobs.dueJobs(10)).map((due) => due.id)).not.toContain(job.id);
    const claimed = await jobs.claimJob(WORKSPACE, job.id, { token: "dispatch_1", forMs: 60_000, status: "dispatched", kind: "dispatch" });
    expect(claimed.ok).toBe(false);
  });

  it("is re-dispatched by a sweep, with a line in the feed saying why", async () => {
    const { jobs, job, bot } = await running();
    const { overrideBuildId } = await import("../agent/lib/build");
    const { dispatchDue } = await import("../agent/lib/dispatch");
    const { recentActivity } = await import("../agent/lib/activity");
    overrideBuildId("build-B");

    const sent: string[] = [];
    const outcome = await dispatchDue(async (due, message) => {
      sent.push(`${due.room}: ${message}`);
    });
    expect(outcome).toMatchObject({ due: 1, dispatched: 1, stranded: 1 });
    expect(sent[0]).toContain(`Job ${job.id} is due`);
    const stranded = (await recentActivity(WORKSPACE, { jobId: job.id })).find((event) => event.kind === "job.stranded");
    expect(stranded?.text).toContain(`${bot.name} was on "${job.title}"`);
    expect(stranded?.data).toMatchObject({ from: "build-A", to: "build-B" });
    expect((await jobs.getJob(WORKSPACE, job.id))?.lease).toMatchObject({ kind: "dispatch", build: "build-B" });

    // A second pass finds nothing: the dispatch lease is this build's.
    expect(await dispatchDue(async () => undefined)).toMatchObject({ due: 0, dispatched: 0, stranded: 0 });
  });

  it("puts the job back when HQ cannot be reached", async () => {
    const { jobs, job } = await running();
    const { overrideBuildId } = await import("../agent/lib/build");
    const { dispatchDue } = await import("../agent/lib/dispatch");
    overrideBuildId("build-B");
    const outcome = await dispatchDue(async () => {
      throw new Error("HQ is down");
    });
    expect(outcome).toMatchObject({ due: 1, dispatched: 0, stranded: 1 });
    expect((await jobs.getJob(WORKSPACE, job.id))?.lease).toBeNull();
  });
});
