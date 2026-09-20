import { describe, expect, it } from "vitest";

import { resultIsFromRun } from "../agent/lib/jobs";
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
