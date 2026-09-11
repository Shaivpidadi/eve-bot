import { record } from "./activity";
import { newId } from "./ids";
import { getBot, patchBot } from "./bots";
import { DEFAULT_EFFORT, type JobEffort } from "./models";
import { deleteDoc, listDocs, readDoc, store, updateDoc, writeDoc } from "./store";
import type { Job, JobArtifact, JobResult, JobStatus } from "./types";

const key = (workspaceId: string, jobId: string) => `jobs/${workspaceId}/${jobId}.json`;

/**
 * Every unfinished job has a marker under this prefix, so the minute tick reads
 * the open work instead of the whole job history. Markers are a superset of the
 * open jobs: written before a job can be picked up, removed only after it closes.
 */
const OPEN_INDEX = "index/open/";
const INDEX_BUILT = "index/open.built";
const openMarker = (workspaceId: string, jobId: string) => `${OPEN_INDEX}${workspaceId}/${jobId}`;
/** A marker with no job behind it may belong to an assignment still being written. */
const ORPHAN_MARKER_MS = 10 * 60_000;

/** Statuses the minute tick hands to HQ. */
const DISPATCHABLE: readonly JobStatus[] = ["scheduled", "queued", "dispatched", "running"];
/** Statuses an explicit run may start from, including a retry of a failed or sent-back job. */
const RUNNABLE: readonly JobStatus[] = [...DISPATCHABLE, "blocked", "failed"];
/** Statuses nothing will pick up again on its own. */
const CLOSED: readonly JobStatus[] = ["done", "failed", "cancelled"];

const stamp = (job: Job): Job => ({ ...job, updatedAt: new Date().toISOString() });

async function markOpen(workspaceId: string, jobId: string): Promise<void> {
  await store().put(openMarker(workspaceId, jobId), new Date().toISOString());
}

async function markClosed(workspaceId: string, jobId: string): Promise<void> {
  await deleteDoc(openMarker(workspaceId, jobId));
}

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
  effort?: JobEffort;
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
    effort: input.effort ?? DEFAULT_EFFORT,
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
  // Index first: a crash after this line leaves a harmless marker, never an
  // open job the dispatcher cannot see.
  await markOpen(job.workspaceId, job.id);
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
  options: { status?: readonly JobStatus[]; botId?: string; limit?: number } = {},
): Promise<Job[]> {
  const jobs = await listDocs<Job>(`jobs/${workspaceId}/`);
  return jobs
    .filter((job) => (options.status ? options.status.includes(job.status) : true))
    .filter((job) => (options.botId ? job.botId === options.botId : true))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, options.limit ?? 50);
}

/** Unfinished jobs in one workspace, read through the open-job index. */
export async function listOpenJobs(workspaceId: string): Promise<Job[]> {
  await ensureOpenIndex();
  const prefix = `${OPEN_INDEX}${workspaceId}/`;
  const markers = await store().list(prefix);
  const jobs = await Promise.all(
    markers.map((marker) => getJob(workspaceId, marker.slice(prefix.length))),
  );
  return jobs
    .filter((job): job is Job => job !== null && !CLOSED.includes(job.status))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

/** Builds the open-job index once for stores written before it existed. */
let indexReady = false;
async function ensureOpenIndex(): Promise<void> {
  if (indexReady) return;
  if ((await store().get(INDEX_BUILT)) === null) {
    const jobs = await listDocs<Job>("jobs/");
    await Promise.all(
      jobs
        .filter((job) => !CLOSED.includes(job.status))
        .map((job) => markOpen(job.workspaceId, job.id)),
    );
    await store().put(INDEX_BUILT, new Date().toISOString());
  }
  indexReady = true;
}

/**
 * Jobs the dispatcher should wake up, across every workspace.
 *
 * A job is due when it is ready to run and its start time has passed, or when a
 * previous run holds an expired lease — that is how work resumes after a crash
 * instead of sitting claimed forever. Only the open-job index is read.
 */
export async function dueJobs(limit = 25): Promise<Job[]> {
  await ensureOpenIndex();
  const now = Date.now();
  const markers = await store().list(OPEN_INDEX);

  const open = await Promise.all(
    markers.map(async (marker) => {
      const path = marker.slice(OPEN_INDEX.length);
      const cut = path.lastIndexOf("/");
      if (cut <= 0) return null;
      const job = await getJob(path.slice(0, cut), path.slice(cut + 1));

      if (job === null) {
        const written = await store().get(marker);
        const age = written === null ? Infinity : now - Date.parse(written.value);
        if (!(age < ORPHAN_MARKER_MS)) await deleteDoc(marker);
        return null;
      }
      // Failed jobs keep their marker until failJob removes it, because a
      // retry may be re-opening the job at this very moment.
      if (job.status === "done" || job.status === "cancelled") await deleteDoc(marker);
      return job;
    }),
  );

  return open
    .filter((job): job is Job => job !== null)
    .filter((job) => DISPATCHABLE.includes(job.status))
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

export type Claim = { ok: true; job: Job } | { ok: false; reason: string };

function unavailable(job: Job): string {
  if (job.status === "cancelled") return "That job was cancelled.";
  if (job.status === "done") return "That job is already finished.";
  return `That job is ${job.status}.`;
}

/**
 * Takes exclusive ownership of a job.
 *
 * Two cron ticks can overlap and a durable step can replay, so ownership is a
 * compare-and-set on the stored record, not an in-memory flag. A `dispatch`
 * claim only picks up open work; a `run` claim may also retry a failed or
 * blocked job, and takes over a dispatcher's lease.
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
    /** The wait lease this run took while it slept until the start time. */
    waitToken?: string;
    /** Start now even though another run is waiting for the start time. */
    takeOverWait?: boolean;
  },
): Promise<Claim> {
  const allowed = options.kind === "run" ? RUNNABLE : DISPATCHABLE;
  // A retry re-opens a closed job, so it must be indexed before it is claimed.
  if (options.kind === "run") await markOpen(workspaceId, jobId);

  const now = Date.now();
  const outcome = { reason: `No job ${jobId} in this workspace.` };
  const job = await updateDoc<Job>(key(workspaceId, jobId), (current) => {
    if (current === null) return null;
    if (!allowed.includes(current.status)) {
      outcome.reason = unavailable(current);
      return null;
    }

    const lease = current.lease;
    if (lease !== null && Date.parse(lease.until) > now) {
      // A run takes over the dispatcher's lease — that hand-off is the whole
      // point of dispatching. Anything else waits for the lease to lapse.
      const handOff =
        options.kind === "run" &&
        (lease.kind === "dispatch" ||
          (lease.kind === "wait" && (lease.token === options.waitToken || options.takeOverWait === true)));
      if (!handOff) {
        outcome.reason =
          lease.kind === "signoff"
            ? "It is waiting on sign-off. Answer that request first."
            : lease.kind === "run"
              ? "A bot is already working on it."
              : lease.kind === "wait"
                ? `It is scheduled to start at ${current.runAt}. Pass now: true to start it early.`
                : "The dispatcher just handed it off; it will start in a moment.";
        return null;
      }
    }

    return {
      ...current,
      status: options.status,
      attempts: current.attempts + (options.countAttempt === true ? 1 : 0),
      error: options.kind === "run" ? null : current.error,
      lease: {
        token: options.token,
        until: new Date(now + options.forMs).toISOString(),
        kind: options.kind,
      },
      lastRunAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
    };
  });

  return job === null ? { ok: false, reason: outcome.reason } : { ok: true, job };
}

export type Hold =
  | { kind: "due" }
  | { kind: "wait"; runAt: string; title: string }
  | { kind: "refused"; reason: string };

/** How long a sleeping run's hold outlives the start time before the watchdog may step in. */
const WAIT_GRACE_MS = 15 * 60_000;

/**
 * Holds a job that is not due yet for the run that will start it.
 *
 * `run_job` sleeps until a job's start time instead of something polling for
 * it, and this lease is how the watchdog knows the job already has a run
 * waiting. It lapses a grace period after the start time, so a run that never
 * wakes (its session was reset, say) leaves the job to the watchdog.
 */
export async function holdUntilDue(workspaceId: string, jobId: string, token: string): Promise<Hold> {
  const now = Date.now();
  const outcome: { hold: Hold } = {
    hold: { kind: "refused", reason: `No job ${jobId} in this workspace.` },
  };
  await updateDoc<Job>(key(workspaceId, jobId), (current) => {
    if (current === null) return null;
    const startsAt = Date.parse(current.runAt);
    if (!DISPATCHABLE.includes(current.status) || !(startsAt > now)) {
      // Due, failed, and sent-back jobs start straight away; claimJob decides whether they may.
      outcome.hold = RUNNABLE.includes(current.status)
        ? { kind: "due" }
        : { kind: "refused", reason: unavailable(current) };
      return null;
    }
    const lease = current.lease;
    const mine = lease?.kind === "wait" && lease.token === token;
    if (lease !== null && Date.parse(lease.until) > now && !mine) {
      outcome.hold =
        lease.kind === "dispatch"
          ? { kind: "due" }
          : {
              kind: "refused",
              reason:
                lease.kind === "wait"
                  ? `It is already scheduled to start at ${current.runAt}.`
                  : lease.kind === "signoff"
                    ? "It is waiting on sign-off. Answer that request first."
                    : "A bot is already working on it.",
            };
      return null;
    }
    outcome.hold = { kind: "wait", runAt: current.runAt, title: current.title };
    return stamp({
      ...current,
      lease: { token, kind: "wait", until: new Date(startsAt + WAIT_GRACE_MS).toISOString() },
    });
  });
  return outcome.hold;
}

/**
 * Extends a run's lease while its bot is still working. Returns `false` when
 * the run no longer owns the job, which means someone else took it over.
 */
export async function renewLease(
  workspaceId: string,
  jobId: string,
  token: string,
  forMs: number,
): Promise<boolean> {
  const job = await updateDoc<Job>(key(workspaceId, jobId), (current) => {
    if (current === null || current.lease === null || current.lease.token !== token) return null;
    return stamp({
      ...current,
      lease: { ...current.lease, until: new Date(Date.now() + forMs).toISOString() },
    });
  });
  return job !== null;
}

/**
 * Parks a finished run on a person. The job reads as blocked, so the tick will
 * not re-dispatch it, and a `signoff` lease keeps a manual re-run from racing
 * the pending answer.
 */
export async function holdForSignoff(
  workspaceId: string,
  jobId: string,
  input: { token: string; forMs: number; result: JobResult },
): Promise<Job | null> {
  const job = await updateDoc<Job>(key(workspaceId, jobId), (current) => {
    if (current === null || current.lease?.token !== input.token) return null;
    if (current.status === "cancelled") return null;
    return stamp({
      ...current,
      status: "blocked",
      result: input.result,
      lease: {
        token: input.token,
        until: new Date(Date.now() + input.forMs).toISOString(),
        kind: "signoff",
      },
    });
  });
  if (job !== null) {
    const bot = await getBot(workspaceId, job.botId);
    await record({
      workspaceId,
      kind: "job.blocked",
      botId: job.botId,
      jobId,
      text: `${bot?.name ?? "A bot"} finished "${job.title}" and is waiting for your sign-off.`,
    });
  }
  return job;
}

/** Hands a dispatched job back to the queue when the hand-off did not happen. */
export async function releaseJob(
  workspaceId: string,
  jobId: string,
  options: { token?: string } = {},
): Promise<Job | null> {
  return updateDoc<Job>(key(workspaceId, jobId), (current) => {
    if (current === null || current.status !== "dispatched") return null;
    if (options.token !== undefined && current.lease?.token !== options.token) return null;
    return stamp({ ...current, status: "queued", lease: null });
  });
}

export async function patchJob(
  workspaceId: string,
  jobId: string,
  patch: (job: Job) => Job,
): Promise<Job | null> {
  return updateDoc<Job>(key(workspaceId, jobId), (current) =>
    current === null ? null : stamp(patch(current)),
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

/**
 * Whether a run still owns the job it is closing. Without a token the caller is
 * not a run (an operator action), so it always may. A run whose lease was taken
 * over by another run must not overwrite that run's outcome.
 */
function owns(job: Job, token: string | undefined): boolean {
  return token === undefined || job.lease === null || job.lease.token === token;
}

type CloseOutcome = "closed" | "cancelled" | "superseded";

/**
 * Closes a run. Repeating jobs go back to `scheduled` with their next start
 * time. A job cancelled mid-run stays cancelled; its result is still kept.
 */
export async function completeJob(
  workspaceId: string,
  jobId: string,
  result: JobResult,
  options: { token?: string } = {},
): Promise<Job | null> {
  const state: { outcome: CloseOutcome } = { outcome: "superseded" };
  const job = await updateDoc<Job>(key(workspaceId, jobId), (current) => {
    if (current === null) return null;
    if (current.status === "cancelled") {
      state.outcome = "cancelled";
      return stamp({ ...current, result });
    }
    if (!owns(current, options.token)) {
      state.outcome = "superseded";
      return null;
    }
    state.outcome = "closed";
    const repeats = current.everyMinutes !== null && current.everyMinutes > 0;
    return stamp({
      ...current,
      status: repeats ? "scheduled" : "done",
      runAt: repeats
        ? new Date(Date.now() + (current.everyMinutes ?? 0) * 60_000).toISOString()
        : current.runAt,
      lease: null,
      result,
      feedback: null,
      error: null,
    });
  });

  if (job !== null && state.outcome === "closed") {
    if (job.status === "done") await markClosed(workspaceId, jobId);
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
  options: { retryInMinutes?: number; token?: string } = {},
): Promise<Job | null> {
  const retry = options.retryInMinutes;
  const state: { outcome: CloseOutcome } = { outcome: "superseded" };
  const job = await updateDoc<Job>(key(workspaceId, jobId), (current) => {
    if (current === null) return null;
    if (current.status === "cancelled") {
      state.outcome = "cancelled";
      return null;
    }
    if (!owns(current, options.token)) {
      state.outcome = "superseded";
      return null;
    }
    state.outcome = "closed";
    return stamp({
      ...current,
      status: retry === undefined ? "failed" : "scheduled",
      runAt:
        retry === undefined
          ? current.runAt
          : new Date(Date.now() + retry * 60_000).toISOString(),
      lease: null,
      error,
    });
  });

  if (job !== null && state.outcome === "closed") {
    if (job.status === "failed") await markClosed(workspaceId, jobId);
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

/** Parks a job on a human. It stays open and can be re-run once they answer. */
export async function blockJob(
  workspaceId: string,
  jobId: string,
  question: string,
  options: { token?: string; result?: JobResult } = {},
): Promise<Job | null> {
  const job = await updateDoc<Job>(key(workspaceId, jobId), (current) => {
    if (current === null || current.status === "cancelled") return null;
    if (!owns(current, options.token)) return null;
    return stamp({
      ...current,
      status: "blocked",
      lease: null,
      error: null,
      result: options.result ?? current.result,
    });
  });
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

/**
 * A person sent finished work back with a note. The job stays with its bot and
 * goes back in the queue, due now, with the note riding into the next brief
 * next to the result it is about. HQ starts the fresh run; the watchdog picks
 * the job up if nothing does.
 */
export async function sendBack(
  workspaceId: string,
  jobId: string,
  note: string,
  options: { token: string; result: JobResult },
): Promise<Job | null> {
  const job = await updateDoc<Job>(key(workspaceId, jobId), (current) => {
    if (current === null || current.status === "cancelled") return null;
    if (!owns(current, options.token)) return null;
    return stamp({
      ...current,
      status: "queued",
      runAt: new Date().toISOString(),
      lease: null,
      error: null,
      result: options.result,
      feedback: note,
    });
  });
  if (job !== null) {
    await record({
      workspaceId,
      kind: "job.blocked",
      botId: job.botId,
      jobId,
      text: `Sent back "${job.title}" for changes: ${note}`,
    });
  }
  return job;
}

export type Cancel = { ok: true; job: Job; wasRunning: boolean } | { ok: false; reason: string };

/** Stops a job and its repetition. Finished work is left as it was. */
export async function cancelJob(workspaceId: string, jobId: string): Promise<Cancel> {
  const outcome = { reason: `No job ${jobId} in this workspace.`, wasRunning: false };
  const job = await updateDoc<Job>(key(workspaceId, jobId), (current) => {
    if (current === null) return null;
    if (current.status === "done" || current.status === "cancelled") {
      outcome.reason = unavailable(current);
      return null;
    }
    outcome.wasRunning = current.status === "running";
    return stamp({ ...current, status: "cancelled", lease: null, everyMinutes: null });
  });
  if (job === null) return { ok: false, reason: outcome.reason };

  await markClosed(workspaceId, jobId);
  await record({
    workspaceId,
    kind: "job.cancelled",
    botId: job.botId,
    jobId,
    text: `Cancelled "${job.title}".`,
  });
  return { ok: true, job, wasRunning: outcome.wasRunning };
}
