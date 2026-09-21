import type { JobResult } from "./types";

/**
 * Comparing what two cycles of a routine found.
 *
 * Its own module, and free of Node APIs on purpose: this runs in the
 * workflow driver body, which is bundled for an environment where importing
 * the store — and through it `node:path` — is a build error.
 */
export function sameFindings(previous: string | null, next: JobResult): boolean {
  if (previous === null) return false;
  let before: JobResult;
  try {
    before = JSON.parse(previous) as JobResult;
  } catch {
    return false;
  }
  const findings = (result: JobResult) =>
    JSON.stringify({
      summary: result.summary.trim(),
      deliverable: result.deliverable.trim(),
      openQuestions: [...result.openQuestions].map((question) => question.trim()).sort(),
      needsHuman: result.needsHuman,
    });
  return findings(before) === findings(next);
}

