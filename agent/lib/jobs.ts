import { record } from "./activity";
import { newId } from "./ids";
import { getBot, patchBot } from "./bots";
import { listDocs, readDoc, updateDoc, writeDoc } from "./store";
import type { Job, JobArtifact, JobResult, JobStatus } from "./types";

const key = (workspaceId: string, jobId: string) => `jobs/${workspaceId}/${jobId}.json`;

/** Statuses a dispatcher may take over. */
const CLAIMABLE: readonly JobStatus[] = ["scheduled", "queued", "dispatched", "running"];
const OPEN: readonly JobStatus[] = ["scheduled", "queued", "dispatched", "running"];

export async function assignJob(input: {
  workspaceId: string;
  botId: string;
  requestedBy: string;
  title: string;
  brief: string;
  successCriteria?: string[];
  runAt?: string;
  everyMinutes?: number | null;
  requiresSignoff?: boolean;
  priority?: "normal" | "high";
  room?: string;
}): Promise<Job> {
  const now = new Date().toISOString();
  const runAt = input.runAt ?? now;
  const job: Job = {
    id: newId("job"),
    workspaceId: input.workspaceId,
    botId: input.botId,
    title: input.title,
    brief: input.brief,
    successCriteria: input.successCriteria ?? [],
    status: Date.parse(runAt) > Date.now() ? "scheduled" : "queued",
    priority: input.priority ?? "normal",
    runAt,
    everyMinutes: input.everyMinutes ?? null,
    requiresSignoff: input.requiresSignoff ?? false,
    room: input.room ?? "desk",
    requestedBy: input.requestedBy,
    createdAt: now,
    updatedAt: now,
    attempts: 0,
    lease: null,
    sessionId: null,
    agentId: null,
    result: null,
    error: null,
    artifacts: [],
    lastRunAt: null,
  };
  await writeDoc(key(job.workspaceId, job.id), job, null);
  const bot = await getBot(job.workspaceId, job.botId);
  await record({
    workspaceId: job.workspaceId,
    kind: "job.assigned",
    botId: job.botId,
    jobId: job.id,
    text: `${bot?.name ?? job.botId} was assigned "${job.title}".`,
  });
  return job;
}

export async function getJob(workspaceId: string, jobId: string): Promise<Job | null> {
  return (await readDoc<Job>(key(workspaceId, jobId)))?.value ?? null;
}

export async function listJobs(
  workspaceId: string,
  options: { status?: JobStatus[]; botId?: string; limit?: number } = {},
): Promise<Job[]> {
  const jobs = await listDocs<Job>(`jobs/${workspaceId}/`);
  return jobs
    .filter((job) => (options.status ? options.status.includes(job.status) : true))
    .filter((job) => (options.botId ? job.botId === options.botId : true))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, options.limit ?? 50);
}

/**
 * Jobs the dispatcher should wake up, across every workspace.
 *
 * A job is due when it is ready to run and its start time has passed, or when a
 * previous run holds an expired lease — that is how work resumes after a crash
 * instead of sitting claimed forever.
 */
export async function dueJobs(limit = 25): Promise<Job[]> {
  const now = Date.now();
  const jobs = await listDocs<Job>("jobs/");
  return jobs
    .filter((job) => OPEN.includes(job.status))
    .filter((job) => Date.parse(job.runAt) <= now)
    .filter((job) => job.lease === null || Date.parse(job.lease.until) <= now)
    .sort((left, right) =>
      left.priority === right.priority
        ? left.runAt.localeCompare(right.runAt)
        : left.priority === "high"
          ? -1
          : 1,
    )
    .slice(0, limit);
}

/**
 * Takes exclusive ownership of a job.
 *
 * Two cron ticks can overlap and a durable step can replay, so ownership is a
 * compare-and-set on the stored record, not an in-memory flag. Returns `null`
 * when someone else holds a live lease.
 */
export async function claimJob(
  workspaceId: string,
  jobId: string,
  options: {
    token: string;
    forMs: number;
    status: JobStatus;
    kind: "dispatch" | "run";
    countAttempt?: boolean;
  },
): Promise<Job | null> {
  const now = Date.now();
  return updateDoc<Job>(key(workspaceId, jobId), (current) => {
    if (current === null) return null;
    if (!CLAIMABLE.includes(current.status)) return null;

    const live = current.lease !== null && Date.parse(current.lease.until) > now;
    // A run takes over the dispatcher's lease — that hand-off is the whole point
    // of dispatching. Anything else waits for the lease to lapse.
    const blocked = live && !(options.kind === "run" && current.lease?.kind === "dispatch");
    if (blocked) return null;

    return {
      ...current,
      status: options.status,
      attempts: current.attempts + (options.countAttempt === true ? 1 : 0),
      lease: {
        token: options.token,
        until: new Date(now + options.forMs).toISOString(),
        kind: options.kind,
      },
      lastRunAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
    };
  });
}

/** Hands a job back to the queue when a dispatch could not be delivered. */
export async function releaseJob(workspaceId: string, jobId: string): Promise<Job | null> {
  return patchJob(workspaceId, jobId, (job) => ({ ...job, status: "queued", lease: null }));
}

export async function patchJob(
  workspaceId: string,
  jobId: string,
  patch: (job: Job) => Job,
): Promise<Job | null> {
  return updateDoc<Job>(key(workspaceId, jobId), (current) =>
    current === null ? null : { ...patch(current), updatedAt: new Date().toISOString() },
  );
}

export async function attachArtifact(
  workspaceId: string,
  jobId: string,
  artifact: JobArtifact,
): Promise<Job | null> {
  return patchJob(workspaceId, jobId, (job) => ({
    ...job,
    artifacts: [...job.artifacts, artifact],
  }));
}

/** Closes a run. Repeating jobs go back to `scheduled` with their next start time. */
export async function completeJob(
  workspaceId: string,
  jobId: string,
  result: JobResult,
): Promise<Job | null> {
  const job = await patchJob(workspaceId, jobId, (current) => {
    const repeats = current.everyMinutes !== null && current.everyMinutes > 0;
    return {
      ...current,
      status: repeats ? "scheduled" : "done",
      runAt: repeats
        ? new Date(Date.now() + (current.everyMinutes ?? 0) * 60_000).toISOString()
        : current.runAt,
      lease: null,
      result,
      error: null,
    };
  });
  if (job !== null) {
    await patchBot(workspaceId, job.botId, (bot) => ({
      ...bot,
      stats: { ...bot.stats, jobsCompleted: bot.stats.jobsCompleted + 1 },
    }));
    await record({
      workspaceId,
      kind: "job.done",
      botId: job.botId,
      jobId,
      text: `Finished "${job.title}": ${result.summary}`,
    });
  }
  return job;
}

export async function failJob(
  workspaceId: string,
  jobId: string,
  error: string,
  options: { retryInMinutes?: number } = {},
): Promise<Job | null> {
  const retry = options.retryInMinutes;
  const job = await patchJob(workspaceId, jobId, (current) => ({
    ...current,
    status: retry === undefined ? "failed" : "scheduled",
    runAt:
      retry === undefined
        ? current.runAt
        : new Date(Date.now() + retry * 60_000).toISOString(),
    lease: null,
    error,
  }));
  if (job !== null) {
    await patchBot(workspaceId, job.botId, (bot) => ({
      ...bot,
      stats: { ...bot.stats, jobsFailed: bot.stats.jobsFailed + 1 },
    }));
    await record({
      workspaceId,
      kind: "job.failed",
      botId: job.botId,
      jobId,
      text: `Could not finish "${job.title}": ${error}`,
    });
  }
  return job;
}

export async function blockJob(
  workspaceId: string,
  jobId: string,
  question: string,
): Promise<Job | null> {
  const job = await patchJob(workspaceId, jobId, (current) => ({
    ...current,
    status: "blocked",
    lease: null,
    error: null,
  }));
  if (job !== null) {
    await record({
      workspaceId,
      kind: "job.blocked",
      botId: job.botId,
      jobId,
      text: `Waiting on a human for "${job.title}": ${question}`,
    });
  }
  return job;
}

export async function cancelJob(workspaceId: string, jobId: string): Promise<Job | null> {
  const job = await patchJob(workspaceId, jobId, (current) => ({
    ...current,
    status: "cancelled",
    lease: null,
    everyMinutes: null,
  }));
  if (job !== null) {
    await record({
      workspaceId,
      kind: "job.cancelled",
      botId: job.botId,
      jobId,
      text: `Cancelled "${job.title}".`,
    });
  }
  return job;
}
