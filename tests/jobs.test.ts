import { describe, expect, it } from "vitest";

import { isRoutine, nextRunAt, resultIsFromRun, sameFindings } from "../agent/lib/jobs";
import type { JobResult } from "../agent/lib/types";

const result = (over: Partial<JobResult> = {}): JobResult => ({
  summary: "Nothing changed since the last check.",
  deliverable: "No new listings.",
  openQuestions: [],
  needsHuman: false,
  ...over,
});

describe("resultIsFromRun", () => {
  it("accepts a result recorded during this run", () => {
    const run = { startedAt: "2026-09-20T10:00:00.000Z", resultAtClaim: null };
    expect(resultIsFromRun(result({ recordedAt: "2026-09-20T10:00:05.000Z" }), run)).toBe(true);
  });

  it("accepts a cycle whose result repeats the last cycle's word for word", () => {
    const earlier = result({ recordedAt: "2026-09-20T09:00:00.000Z" });
    const run = { startedAt: "2026-09-20T10:00:00.000Z", resultAtClaim: JSON.stringify(earlier) };
    // Same summary and deliverable as the cycle before: only the moment differs.
    expect(resultIsFromRun(result({ recordedAt: "2026-09-20T10:00:03.000Z" }), run)).toBe(true);
  });

  it("rejects the result an earlier run left behind", () => {
    const run = { startedAt: "2026-09-20T10:00:00.000Z", resultAtClaim: null };
    expect(resultIsFromRun(result({ recordedAt: "2026-09-20T09:59:59.000Z" }), run)).toBe(false);
  });

  it("falls back to comparing the text for results recorded before the stamp", () => {
    const old = result();
    const run = { startedAt: "2026-09-20T10:00:00.000Z", resultAtClaim: JSON.stringify(old) };
    expect(resultIsFromRun(old, run)).toBe(false);
    expect(resultIsFromRun(result({ summary: "Two new listings." }), run)).toBe(true);
  });
});

describe("sameFindings", () => {
  const monitor = (over: Partial<JobResult> = {}): JobResult => ({
    summary: "No new listings since the last check.",
    deliverable: "Checked 14 pages. Nothing new.",
    openQuestions: [],
    needsHuman: false,
    ...over,
  });

  it("sees through the parts that differ every cycle", () => {
    const previous = JSON.stringify(monitor({ recordedAt: "2026-09-20T09:00:00.000Z", completion: "verified" }));
    expect(sameFindings(previous, monitor({ recordedAt: "2026-09-20T09:10:00.000Z", completion: "recorded" }))).toBe(true);
  });

  it("reports a cycle that found something", () => {
    const previous = JSON.stringify(monitor());
    expect(sameFindings(previous, monitor({ summary: "Two new listings." }))).toBe(false);
    expect(sameFindings(previous, monitor({ needsHuman: true }))).toBe(false);
  });

  it("treats a first cycle, or an unreadable previous result, as new", () => {
    expect(sameFindings(null, monitor())).toBe(false);
    expect(sameFindings("not json", monitor())).toBe(false);
  });
});

describe("isRoutine and nextRunAt", () => {
  it("counts both kinds of repeat", () => {
    expect(isRoutine({ everyMinutes: null, schedule: null })).toBe(false);
    expect(isRoutine({ everyMinutes: 10, schedule: null })).toBe(true);
    expect(isRoutine({ everyMinutes: null, schedule: { hour: 9, minute: 0, timezone: "UTC" } })).toBe(true);
  });

  it("prefers the clock over the interval", () => {
    const from = new Date("2026-09-20T10:00:00Z");
    expect(nextRunAt({ everyMinutes: 10, schedule: { hour: 9, minute: 0, timezone: "UTC" } }, from)).toBe(
      "2026-09-21T09:00:00.000Z",
    );
    expect(nextRunAt({ everyMinutes: 10, schedule: null }, from)).toBe("2026-09-20T10:10:00.000Z");
  });
});
