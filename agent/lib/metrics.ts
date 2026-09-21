import type { ActivityEvent, Job, JobCompletion } from "./types";

/**
 * How well the Bots are actually doing, from what they already recorded.
 *
 * Every change in this system is supposed to make jobs finish more often,
 * with fewer interruptions, faster. None of that is knowable from a demo, and
 * "it feels better" has been wrong before. The jobs and the activity feed
 * already hold the answer; this reads it back.
 *
 * A note on what is *not* here: cost per job. Nothing records what a job's
 * model steps cost today — eve enforces a budget without writing the spend
 * into the feed — so an honest report leaves it out rather than inventing it.
 */

export interface JobOutcome {
  readonly jobId: string;
  readonly title: string;
  readonly status: Job["status"];
  /** How the close was reached, when the job carried a result that says. */
  readonly completion: JobCompletion | "unknown";
  /** Wall-clock from the run starting to the job closing, when both are in the feed. */
  readonly elapsedMs: number | null;
  /** Times a person was pulled in: a takeover asked for, or an approval requested. */
  readonly interventions: number;
  /** Whether the bot ended by saying a person has to act. */
  readonly needsHuman: boolean;
}

export interface Summary {
  readonly jobs: number;
  readonly done: number;
  readonly failed: number;
  readonly blocked: number;
  /** Closed jobs by how much the close can be trusted. */
  readonly completion: Readonly<Record<JobCompletion | "unknown", number>>;
  /**
   * Closed jobs the bot said it had checked, over all closed jobs. The number
   * every change here is meant to move.
   */
  readonly verifiedRate: number | null;
  /**
   * Closed jobs whose result was assembled from leftovers rather than
   * recorded. A close nobody claimed is the quiet kind of false success.
   */
  readonly recoveredRate: number | null;
  readonly interventionsPerJob: number | null;
  readonly medianElapsedMs: number | null;
  readonly outcomes: readonly JobOutcome[];
}

const CLOSED: readonly Job["status"][] = ["done", "failed", "cancelled"];
const INTERVENTION: readonly ActivityEvent["kind"][] = ["computer.takeover", "input.requested", "job.blocked"];

const median = (values: readonly number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round(((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2) : (sorted[middle] as number);
};

/** One job's story, from its record and the events that mention it. */
export function outcomeOf(job: Job, events: readonly ActivityEvent[]): JobOutcome {
  const mine = events.filter((event) => event.jobId === job.id);
  const started = mine.filter((event) => event.kind === "job.started").at(-1)?.at;
  const ended = mine.find((event) => event.kind === "job.done" || event.kind === "job.failed")?.at;
  const elapsed = started !== undefined && ended !== undefined ? Date.parse(ended) - Date.parse(started) : null;
  return {
    jobId: job.id,
    title: job.title,
    status: job.status,
    completion: job.result?.completion ?? "unknown",
    elapsedMs: elapsed !== null && Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null,
    interventions: mine.filter((event) => INTERVENTION.includes(event.kind)).length,
    needsHuman: job.result?.needsHuman === true,
  };
}

/** The numbers to compare one configuration against another. */
export function summarise(jobs: readonly Job[], events: readonly ActivityEvent[]): Summary {
  const outcomes = jobs.map((job) => outcomeOf(job, events));
  const closed = outcomes.filter((outcome) => CLOSED.includes(outcome.status));
  const completion = { verified: 0, recorded: 0, recovered: 0, unknown: 0 } as Record<JobCompletion | "unknown", number>;
  for (const outcome of closed) completion[outcome.completion] += 1;

  const elapsed = outcomes.map((outcome) => outcome.elapsedMs).filter((ms): ms is number => ms !== null);
  const rate = (count: number) => (closed.length === 0 ? null : count / closed.length);

  return {
    jobs: jobs.length,
    done: outcomes.filter((outcome) => outcome.status === "done").length,
    failed: outcomes.filter((outcome) => outcome.status === "failed").length,
    blocked: outcomes.filter((outcome) => outcome.status === "blocked").length,
    completion,
    verifiedRate: rate(completion.verified),
    recoveredRate: rate(completion.recovered),
    interventionsPerJob:
      outcomes.length === 0 ? null : outcomes.reduce((total, outcome) => total + outcome.interventions, 0) / outcomes.length,
    medianElapsedMs: median(elapsed),
    outcomes,
  };
}

/** The summary as a person reads it. */
export function formatSummary(summary: Summary, label: string): string {
  const percent = (value: number | null) => (value === null ? "—" : `${Math.round(value * 100)}%`);
  const duration = (ms: number | null) => (ms === null ? "—" : ms >= 60_000 ? `${(ms / 60_000).toFixed(1)}m` : `${Math.round(ms / 1_000)}s`);
  return [
    `${label}: ${summary.jobs} jobs · ${summary.done} done · ${summary.failed} failed · ${summary.blocked} blocked`,
    `  verified ${percent(summary.verifiedRate)} · recovered ${percent(summary.recoveredRate)} · recorded-only ${
      summary.completion.recorded
    } · unknown ${summary.completion.unknown}`,
    `  median run ${duration(summary.medianElapsedMs)} · ${
      summary.interventionsPerJob === null ? "—" : summary.interventionsPerJob.toFixed(2)
    } interruptions per job`,
  ].join("\n");
}
