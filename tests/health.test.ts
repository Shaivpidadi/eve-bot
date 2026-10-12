import { describe, expect, it } from "vitest";

import { HEALTH_GRACE_MS, jobHealth } from "../agent/lib/health";
import type { Job, JobLeaseKind } from "../agent/lib/types";

const NOW = Date.parse("2026-10-11T12:00:00.000Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const ahead = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();
const lease = (kind: JobLeaseKind, until: string) => ({ token: `t-${kind}`, until, kind });

let seq = 0;
function job(over: Partial<Job> = {}): Job {
  seq += 1;
  return {
    id: `job_${seq}`,
    workspaceId: "default",
    botId: "b1",
    title: `Job ${seq}`,
    brief: "",
    successCriteria: [],
    status: "scheduled",
    priority: "normal",
    runAt: ago(60),
    everyMinutes: 60,
    requiresSignoff: false,
    room: "bot-b1",
    requestedBy: "op",
    createdAt: ago(600),
    updatedAt: ago(60),
    attempts: 0,
    lease: null,
    sessionId: null,
    agentId: null,
    result: null,
    error: null,
    artifacts: [],
    lastRunAt: null,
    ...over,
  };
}

describe("jobHealth", () => {
  it("flags a routine past its start time with nothing holding it", () => {
    const missed = job({ runAt: ago(90) });
    const health = jobHealth([missed], { now: NOW });
    expect(health.overdue).toEqual([
      { jobId: missed.id, botId: "b1", title: missed.title, runAt: missed.runAt, routine: true, lateMinutes: 90 },
    ]);
    expect(health.staleRuns).toEqual([]);
  });

  it("flags a lapsed wait or dispatch lease as overdue, not as a stale worker", () => {
    const slept = job({ lease: lease("wait", ago(30)) });
    const handed = job({ status: "dispatched", lease: lease("dispatch", ago(20)) });
    const health = jobHealth([slept, handed], { now: NOW });
    expect(health.overdue.map((entry) => entry.jobId).sort()).toEqual([slept.id, handed.id].sort());
    expect(health.staleRuns).toEqual([]);
  });

  it("gives a job the grace period before calling it overdue", () => {
    const justDue = job({ runAt: new Date(NOW - HEALTH_GRACE_MS + 60_000).toISOString() });
    expect(jobHealth([justDue], { now: NOW }).overdue).toEqual([]);
    expect(jobHealth([justDue], { now: NOW, graceMs: 0 }).overdue).toHaveLength(1);
  });

  it("flags a run whose lease expired as a stale worker", () => {
    const dead = job({ status: "running", lease: lease("run", ago(5)) });
    const health = jobHealth([dead], { now: NOW });
    expect(health.staleRuns).toEqual([{ jobId: dead.id, botId: "b1", title: dead.title, leaseUntil: ago(5) }]);
    expect(health.overdue).toEqual([]);
  });

  it("leaves healthy work alone", () => {
    const jobs = [
      job({ runAt: ahead(30) }), // not due yet
      job({ lease: lease("wait", ahead(10)) }), // a run is sleeping on it
      job({ status: "dispatched", lease: lease("dispatch", ahead(4)) }), // just handed to HQ
      job({ status: "running", lease: lease("run", ahead(2)) }), // working, lease renewed
    ];
    expect(jobHealth(jobs, { now: NOW })).toEqual({ overdue: [], staleRuns: [] });
  });

  it("does not mistake a person's pending sign-off or a blocked job for a dead worker", () => {
    const jobs = [
      job({ status: "blocked", lease: lease("signoff", ago(600)) }),
      job({ status: "blocked", lease: null }),
    ];
    expect(jobHealth(jobs, { now: NOW })).toEqual({ overdue: [], staleRuns: [] });
  });

  it("marks one-shot work as not a routine, and skips paused Bots", () => {
    const once = job({ everyMinutes: null, status: "queued" });
    const paused = job({ botId: "b2" });
    const health = jobHealth([once, paused], { now: NOW, pausedBotIds: new Set(["b2"]) });
    expect(health.overdue).toHaveLength(1);
    expect(health.overdue[0]).toMatchObject({ jobId: once.id, routine: false });
  });
});
