import { describe, expect, it } from "vitest";

import { formatSummary, outcomeOf, summarise } from "../agent/lib/metrics";
import type { ActivityEvent, Job, JobCompletion } from "../agent/lib/types";

const job = (id: string, status: Job["status"], completion?: JobCompletion): Job =>
  ({
    id,
    workspaceId: "default",
    botId: "bot_1",
    title: `Job ${id}`,
    brief: "",
    successCriteria: [],
    status,
    priority: "normal",
    runAt: "2026-09-20T09:00:00.000Z",
    everyMinutes: null,
    requiresSignoff: false,
    room: "desk",
    requestedBy: "operator",
    createdAt: "2026-09-20T09:00:00.000Z",
    updatedAt: "2026-09-20T09:05:00.000Z",
    attempts: 1,
    lease: null,
    sessionId: null,
    agentId: null,
    result:
      completion === undefined
        ? null
        : { summary: "s", deliverable: "d", openQuestions: [], needsHuman: false, completion },
    error: null,
    artifacts: [],
    lastRunAt: null,
  }) as Job;

const event = (jobId: string, kind: ActivityEvent["kind"], at: string): ActivityEvent => ({
  id: `${jobId}-${kind}-${at}`,
  workspaceId: "default",
  at,
  kind,
  botId: "bot_1",
  jobId,
  text: "",
});

describe("outcomeOf", () => {
  it("times a job from its last start to its close", () => {
    const events = [
      event("a", "job.done", "2026-09-20T09:04:00.000Z"),
      event("a", "job.started", "2026-09-20T09:00:00.000Z"),
    ];
    expect(outcomeOf(job("a", "done", "verified"), events).elapsedMs).toBe(4 * 60_000);
  });

  it("counts the times a person had to step in", () => {
    const events = [
      event("a", "job.started", "2026-09-20T09:00:00.000Z"),
      event("a", "computer.takeover", "2026-09-20T09:01:00.000Z"),
      event("a", "input.requested", "2026-09-20T09:02:00.000Z"),
      event("b", "computer.takeover", "2026-09-20T09:03:00.000Z"),
    ];
    expect(outcomeOf(job("a", "done", "verified"), events).interventions).toBe(2);
  });

  it("says unknown when a result predates the completion state", () => {
    expect(outcomeOf(job("a", "done"), []).completion).toBe("unknown");
    expect(outcomeOf(job("a", "done"), []).elapsedMs).toBeNull();
  });
});

describe("summarise", () => {
  const events = [
    event("a", "job.started", "2026-09-20T09:00:00.000Z"),
    event("a", "job.done", "2026-09-20T09:02:00.000Z"),
    event("b", "job.started", "2026-09-20T10:00:00.000Z"),
    event("b", "job.done", "2026-09-20T10:10:00.000Z"),
    event("b", "computer.takeover", "2026-09-20T10:05:00.000Z"),
  ];
  const jobs = [job("a", "done", "verified"), job("b", "done", "recovered"), job("c", "failed"), job("d", "running")];

  it("reports the rates every change here is meant to move", () => {
    const summary = summarise(jobs, events);
    expect(summary.jobs).toBe(4);
    expect(summary.done).toBe(2);
    expect(summary.failed).toBe(1);
    // Three jobs are closed: two done, one failed.
    expect(summary.verifiedRate).toBeCloseTo(1 / 3);
    expect(summary.recoveredRate).toBeCloseTo(1 / 3);
    expect(summary.completion.unknown).toBe(1);
  });

  it("times and counts across jobs", () => {
    const summary = summarise(jobs, events);
    expect(summary.medianElapsedMs).toBe(6 * 60_000);
    expect(summary.interventionsPerJob).toBeCloseTo(0.25);
  });

  it("says nothing rather than zero when there is nothing to say", () => {
    const empty = summarise([], []);
    expect(empty.verifiedRate).toBeNull();
    expect(empty.medianElapsedMs).toBeNull();
    expect(formatSummary(empty, "nothing")).toContain("verified —");
  });

  it("reads as a person would say it", () => {
    expect(formatSummary(summarise(jobs, events), "today")).toContain("today: 4 jobs · 2 done · 1 failed");
  });
});
