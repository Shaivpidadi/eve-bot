import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A routine whose run fails loses that cycle, not the routine: it is scheduled
 * for its next time with the error kept. A one-off job, or a failure that is
 * final (its Bot left the team), still ends in "failed".
 */

const WORKSPACE = "default";

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv("BOT_STORE", "memory");
});

async function claimed(everyMinutes: number | null) {
  const jobs = await import("../agent/lib/jobs");
  const job = await jobs.assignJob({ workspaceId: WORKSPACE, botId: "bot_1", requestedBy: "operator", title: "Check the disk", brief: "Run df -h.", ...(everyMinutes === null ? {} : { everyMinutes }) });
  expect((await jobs.claimJob(WORKSPACE, job.id, { token: "lease_A", forMs: 60_000, status: "running", kind: "run", countAttempt: true })).ok).toBe(true);
  return { jobs, job };
}

describe("a failed run", () => {
  it("keeps a routine on its schedule, from now", async () => {
    const { jobs, job } = await claimed(30);
    const before = Date.now();
    const failed = await jobs.failJob(WORKSPACE, job.id, "Response stream ended without a finish reason.", { token: "lease_A", routineGoesOn: true });
    expect(failed).toMatchObject({ status: "scheduled", error: "Response stream ended without a finish reason.", lease: null });
    const next = Date.parse(failed!.runAt!);
    expect(next).toBeGreaterThanOrEqual(before + 29 * 60_000);
    expect(next).toBeLessThanOrEqual(Date.now() + 31 * 60_000);
  });

  it("still ends a one-off job, and a routine when the failure is final", async () => {
    const once = await claimed(null);
    expect(await once.jobs.failJob(WORKSPACE, once.job.id, "Broke", { token: "lease_A", routineGoesOn: true })).toMatchObject({ status: "failed" });
    const routine = await claimed(30);
    expect(await routine.jobs.failJob(WORKSPACE, routine.job.id, "Its bot is no longer on the roster.", { token: "lease_A" })).toMatchObject({ status: "failed" });
  });
});
