import { isRoutine } from "./jobs";
import type { Job, JobStatus } from "./types";

/** A job that should have started and has nothing holding it. */
export interface OverdueJob {
  readonly jobId: string;
  readonly botId: string;
  readonly title: string;
  readonly runAt: string;
  readonly routine: boolean;
  /** How long past its start time, in minutes. */
  readonly lateMinutes: number;
}

/** A job whose worker stopped renewing its lease. */
export interface StaleRun {
  readonly jobId: string;
  readonly botId: string;
  readonly title: string;
  /** When the worker's lease ran out. */
  readonly leaseUntil: string;
}

export interface Health {
  readonly overdue: readonly OverdueJob[];
  readonly staleRuns: readonly StaleRun[];
}

/** Long enough for a run waking on time to take its lease; short of a day's wait for the watchdog. */
export const HEALTH_GRACE_MS = 15 * 60_000;

const WAITING_TO_START: readonly JobStatus[] = ["scheduled", "queued", "dispatched"];

/**
 * Whether the team's clockwork is actually turning.
 *
 * Runs keep their own time — `run_job` sleeps durably under a `wait` lease and
 * renews a `run` lease while it works — and the watchdog only sweeps up what
 * fell through, daily on Hobby. So a routine whose sleeping run was lost, or a
 * Bot whose run died mid-job, can sit unnoticed for most of a day. This reads
 * the open jobs the board already loads (never a historical scan) and names
 * both cases, so the console can say so before the next watchdog pass.
 *
 * - **Overdue**: a job waiting to start (`scheduled`, `queued`, `dispatched`)
 *   whose start time passed more than the grace period ago with no live lease
 *   holding it. A live `wait`/`dispatch` lease means something owns it.
 * - **Stale run**: a job whose `run` lease has expired — the worker stopped
 *   renewing it. A lapsed `signoff` or `wait` lease is not a dead worker:
 *   the first is a person who has not answered, the second a sleep that ended.
 *
 * Jobs of paused Bots are left out; their work waits on purpose.
 */
export function jobHealth(
  open: readonly Job[],
  options: { now?: number; graceMs?: number; pausedBotIds?: ReadonlySet<string> } = {},
): Health {
  const now = options.now ?? Date.now();
  const grace = options.graceMs ?? HEALTH_GRACE_MS;
  const paused = options.pausedBotIds ?? new Set<string>();
  const overdue: OverdueJob[] = [];
  const staleRuns: StaleRun[] = [];

  for (const job of open) {
    if (paused.has(job.botId)) continue;
    const leaseLive = job.lease !== null && Date.parse(job.lease.until) > now;

    if (job.lease?.kind === "run" && !leaseLive) {
      staleRuns.push({ jobId: job.id, botId: job.botId, title: job.title, leaseUntil: job.lease.until });
      continue;
    }

    const late = now - Date.parse(job.runAt);
    if (WAITING_TO_START.includes(job.status) && !leaseLive && late > grace) {
      overdue.push({
        jobId: job.id,
        botId: job.botId,
        title: job.title,
        runAt: job.runAt,
        routine: isRoutine(job),
        lateMinutes: Math.floor(late / 60_000),
      });
    }
  }

  overdue.sort((left, right) => left.runAt.localeCompare(right.runAt));
  staleRuns.sort((left, right) => left.leaseUntil.localeCompare(right.leaseUntil));
  return { overdue, staleRuns };
}
