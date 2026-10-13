import { record } from "./activity";
import { buildId } from "./build";
import { newId } from "./ids";
import { getBot, patchBot } from "./bots";
import { DEFAULT_EFFORT, type JobEffort } from "./models";
import { describeSchedule, nextRun, type Schedule } from "./schedule";
import { createDoc, deleteDoc, listDocs, readDoc, store, updateDoc } from "./store";
import type { Job, JobArtifact, JobResult, JobStatus } from "./types";
import { describeUsage } from "./usage";

export const key = (workspaceId: string, jobId: string) => `jobs/${workspaceId}/${jobId}.json`;

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

/** " · claude-sonnet-5 · 12.3k tokens · $0.04" when the job's steps were counted, else nothing. */
const spent = (job: Job): string => {
  const line = describeUsage(job.usage);
  return line === null ? "" : ` · ${line}`;
};

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
  schedule?: Schedule | null;
  requiresSignoff?: boolean;
  priority?: "normal" | "high";
  effort?: JobEffort;
  effortBy?: Job["effortBy"];
  effortConfidence?: number;
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
    effortBy: input.effortBy ?? (input.effort === undefined ? "default" : "hq"),
    ...(input.effortConfidence === undefined ? {} : { effortConfidence: input.effortConfidence }),
    runAt,
    everyMinutes: input.everyMinutes ?? null,
    ...(input.schedule == null ? {} : { schedule: input.schedule }),
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
  await createDoc(key(job.workspaceId, job.id), job);
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

/**
 * Whether the result now on a job was recorded by the run that is asking.
 *
 * A routine's cycle can record a result identical to the last cycle's — a
 * monitor that correctly reports "nothing changed" does it every time — so the
 * text of a result cannot say whether this run recorded anything. A result
 * names the run that recorded it, and that is the answer: a time cannot be,
 * since a run that outlived its lease may record after the next one started.
 * Results without that fall back to the moment they were recorded, and older
 * ones still to the text at claim time.
 */
export function resultIsFromRun(
  result: JobResult,
  run: { readonly token?: string; readonly startedAt: string; readonly resultAtClaim: string | null },
): boolean {
  if (result.producedBy !== undefined && run.token !== undefined) {
    return result.producedBy.token === run.token;
  }
  if (result.recordedAt !== undefined) {
    return Date.parse(result.recordedAt) >= Date.parse(run.startedAt);
  }
  return JSON.stringify(result) !== run.resultAtClaim;
}

/** Whether a job runs again after it finishes: on a clock, or on an interval. */
export const isRoutine = (job: Pick<Job, "everyMinutes" | "schedule">): boolean =>
  (job.schedule !== undefined && job.schedule !== null) || (job.everyMinutes !== null && job.everyMinutes > 0);

/**
 * When a routine's next cycle is due.
 *
 * A clock schedule fires at the same wall-clock time whatever the last cycle
 * took; an interval still counts from now, which is what "every 10 minutes"
 * means for a monitor.
 */
export function nextRunAt(job: Pick<Job, "everyMinutes" | "schedule">, from: Date = new Date()): string {
  if (job.schedule !== undefined && job.schedule !== null) return nextRun(job.schedule, from).toISOString();
  return new Date(from.getTime() + (job.everyMinutes ?? 0) * 60_000).toISOString();
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
  const outcome: { reason: string; mine: Job | null } = { reason: `No job ${jobId} in this workspace.`, mine: null };
  const job = await updateDoc<Job>(key(workspaceId, jobId), (current) => {
    if (current === null) return null;
    const held = current.lease;
    if (held !== null && held.token === options.token && held.kind === options.kind && current.status === options.status) {
      // Already this claim's: a replayed step, or a claim that landed and came
      // back as a conflict (the Blob SDK retries it into its own write). Not
      // "a bot is already working on it": that bot is this run.
      outcome.mine = current;
      return null;
    }
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
        build: buildId(),
      },
      lastRunAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
    };
  });

  const claimed = job ?? outcome.mine;
  return claimed === null ? { ok: false, reason: outcome.reason } : { ok: true, job: claimed };
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
      lease: { token, kind: "wait", until: new Date(startsAt + WAIT_GRACE_MS).toISOString(), build: buildId() },
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
      lease: { ...current.lease, until: new Date(Date.now() + forMs).toISOString(), build: buildId() },
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
        build: buildId(),
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

/**
 * Hands a claimed run back before its bot started, to be tried again at
 * `runAt`: something it needed to start (the budget check) was unavailable,
 * not refused. The job goes back to waiting, `scheduled` for a routine and
 * `queued` otherwise, due at `runAt`, and the claim's attempt is not counted.
 * With `waitToken` the run that will retry holds a `wait` lease until then
 * (as `holdUntilDue` would), so the watchdog leaves it to that run and only
 * steps in once the lease lapses; without one, the watchdog picks it up when
 * it is due. Fenced on the run's token: null when the run no longer owns the
 * job (cancelled, superseded), and nothing is written.
 */
export async function deferRun(
  workspaceId: string,
  jobId: string,
  token: string,
  options: { runAt: string; waitToken?: string },
): Promise<Job | null> {
  const found: { mine: Job | null } = { mine: null };
  const deferred = await updateDoc<Job>(key(workspaceId, jobId), (current) => {
    if (current === null || current.status === "cancelled" || CLOSED.includes(current.status)) return null;
    if (deferredBy(current, options)) {
      // This deferral already landed (a write reported as a conflict): success, not "taken over".
      found.mine = current;
      return null;
    }
    if (current.lease === null || current.lease.token !== token) return null;
    const startsAt = Date.parse(options.runAt);
    return stamp({
      ...current,
      status: isRoutine(current) ? "scheduled" : "queued",
      runAt: options.runAt,
      attempts: Math.max(0, current.attempts - 1),
      lease:
        options.waitToken === undefined
          ? null
          : { token: options.waitToken, kind: "wait", until: new Date(startsAt + WAIT_GRACE_MS).toISOString() },
    });
  });
  return deferred ?? found.mine;
}

/** Whether `job` is already waiting as `deferRun` with these options leaves it. */
function deferredBy(job: Job, options: { runAt: string; waitToken?: string }): boolean {
  if (job.runAt !== options.runAt || (job.status !== "queued" && job.status !== "scheduled")) return false;
  return options.waitToken === undefined ? job.lease === null : job.lease?.kind === "wait" && job.lease.token === options.waitToken;
}

/**
 * Changes when a routine runs, from the console: a new interval or a new clock
 * schedule, effective from now. A routine waiting for its next cycle moves at
 * once; a running cycle keeps its lease and the change lands when it closes,
 * since completeJob computes the next run from the job as it is then.
 */
export async function rescheduleJob(
  workspaceId: string,
  jobId: string,
  change: { readonly everyMinutes?: number | null; readonly schedule?: Schedule | null; readonly title?: string },
): Promise<{ ok: true; job: Job } | { ok: false; reason: string }> {
  let reason = "";
  const job = await updateDoc<Job>(key(workspaceId, jobId), (current) => {
    if (current === null) {
      reason = "No such job.";
      return null;
    }
    if (current.status === "done" || current.status === "cancelled" || current.status === "failed") {
      reason = "That job is over; nothing to reschedule.";
      return null;
    }
    const next: Job = {
      ...current,
      ...(change.title === undefined ? {} : { title: change.title.trim().slice(0, 120) || current.title }),
      ...(change.schedule !== undefined
        ? { schedule: change.schedule, everyMinutes: change.schedule === null ? (change.everyMinutes ?? current.everyMinutes) : null }
        : change.everyMinutes !== undefined
          ? { everyMinutes: change.everyMinutes, schedule: null }
          : {}),
    };
    const waiting = current.status === "scheduled" || current.status === "queued";
    return stamp(waiting && isRoutine(next) ? { ...next, runAt: nextRunAt(next) } : next);
  });
  if (job === null) return { ok: false, reason: reason || "Could not reschedule." };
  await record({
    workspaceId,
    kind: "job.assigned",
    botId: job.botId,
    jobId,
    text: `"${job.title}" now runs ${job.schedule ? describeSchedule(job.schedule) : job.everyMinutes ? `every ${job.everyMinutes} minutes` : "once"}.`,
  });
  return { ok: true, job };
}

/**
 * Whether a teammate session is the run that currently owns a job.
 *
 * A run's lease outlives nothing: when it lapses, the watchdog or a re-run
 * claims the job with a fresh token, and the old bot may still be working. The
 * lease's bound session (see `bindRun`) is what tells the two apart, so every
 * write a teammate makes to its job is checked against it. Failure reasons:
 *
 * - `missing`: no such job.
 * - `cancelled`: a person stopped the job; nothing more should happen for it.
 * - `unbound`: a run holds the job but no session has bound it yet, so the
 *   caller has not presented the run token to `job_brief`.
 * - `superseded`: another run, or nobody, owns the job now; this run's work is over.
 */
export type RunCheck =
  | { ok: true; job: Job }
  | { ok: false; reason: "missing" | "superseded" | "cancelled" | "unbound" };

/** `checkRun` on a record already in hand, so a CAS callback can decide with it. */
export function runCheckOf(job: Job | null, sessionId: string): RunCheck {
  if (job === null) return { ok: false, reason: "missing" };
  if (job.status === "cancelled") return { ok: false, reason: "cancelled" };
  const lease = job.lease;
  if (lease === null || lease.kind !== "run" || CLOSED.includes(job.status)) {
    return { ok: false, reason: "superseded" };
  }
  // Expiry alone is not checked: a lapsed lease nobody re-claimed still names
  // this run, and a re-claim replaces the lease, session and all.
  if (lease.session === undefined) return { ok: false, reason: "unbound" };
  return lease.session === sessionId ? { ok: true, job } : { ok: false, reason: "superseded" };
}

/** Whether `sessionId` is the run that owns the job right now. A read; see `patchJobAsRun` to write. */
export async function checkRun(workspaceId: string, jobId: string, sessionId: string): Promise<RunCheck> {
  return runCheckOf(await getJob(workspaceId, jobId), sessionId);
}

/**
 * Binds a teammate session to the run lease whose token it was briefed with.
 *
 * The parent cannot know its child's session id before the child starts, so
 * the token rides in the brief and the child proves it here, in the same
 * compare-and-set that records the session. A token that is no longer the
 * lease's means a later run claimed the job: refused, nothing written. The
 * token holder may re-bind, since the parent spawns one child per token and a
 * second binding can only be that run started again, which is then the live one.
 */
export async function bindRun(
  workspaceId: string,
  jobId: string,
  runToken: string,
  sessionId: string,
): Promise<RunCheck> {
  const outcome: { check: RunCheck } = { check: { ok: false, reason: "missing" } };
  const job = await updateDoc<Job>(key(workspaceId, jobId), (current) => {
    if (current === null) return null;
    if (current.status === "cancelled") {
      outcome.check = { ok: false, reason: "cancelled" };
      return null;
    }
    const lease = current.lease;
    if (lease === null || lease.kind !== "run" || lease.token !== runToken || CLOSED.includes(current.status)) {
      outcome.check = { ok: false, reason: "superseded" };
      return null;
    }
    if (lease.session === sessionId && current.sessionId === sessionId) {
      // Already bound — or a retried write that had landed: nothing to write,
    // and the record is the answer.
      outcome.check = { ok: true, job: current };
      return null;
    }
    // sessionId links the run to the job for the console; lease.session fences it.
    return stamp({ ...current, sessionId, lease: { ...lease, session: sessionId } });
  });
  return job === null ? outcome.check : { ok: true, job };
}

/**
 * A teammate's write to its job, made only while it is still the job's run.
 *
 * The check and the write are one compare-and-set, so a run superseded between
 * a read and a write still writes nothing. `patch` sees the run it is writing
 * for, which is how a result records who produced it.
 *
 * `patch` must be idempotent and return `null` when its change is already on
 * the record: a store may report a write that landed as a conflict (the Blob
 * SDK retries), and the compare-and-set then runs `patch` again on the record
 * that already has it. `null` there is success, with nothing written twice.
 */
export async function patchJobAsRun(
  workspaceId: string,
  jobId: string,
  sessionId: string,
  patch: (job: Job, run: { readonly token: string; readonly session: string }) => Job | null,
): Promise<RunCheck> {
  const outcome: { check: RunCheck } = { check: { ok: false, reason: "missing" } };
  const job = await updateDoc<Job>(key(workspaceId, jobId), (current) => {
    const check = runCheckOf(current, sessionId);
    outcome.check = check;
    if (!check.ok) return null;
    const lease = check.job.lease!;
    const next = patch(check.job, { token: lease.token, session: sessionId });
    return next === null ? null : stamp(next);
  });
  return job === null ? outcome.check : { ok: true, job };
}

/**
 * Where a run stands by its lease token, for the parent workflow: whether it
 * still owns the job, a person cancelled it, or another run (or nobody) holds it.
 */
export type Standing = "owns" | "cancelled" | "superseded" | "missing";

export function standingOf(job: Job | null, token: string): Standing {
  if (job === null) return "missing";
  if (job.status === "cancelled") return "cancelled";
  return job.lease !== null && job.lease.token === token && !CLOSED.includes(job.status) ? "owns" : "superseded";
}

export async function runStanding(workspaceId: string, jobId: string, token: string): Promise<Standing> {
  return standingOf(await getJob(workspaceId, jobId), token);
}

/** What a refused run is told, in words a model acts on. */
export function describeRunRefusal(reason: Exclude<RunCheck, { ok: true }>["reason"], jobId: string): string {
  switch (reason) {
    case "missing":
      return `No job ${jobId}.`;
    case "cancelled":
      return `Job ${jobId} was cancelled. Stop working on it and end your turn without further actions.`;
    case "unbound":
      return `Call job_brief with the jobId and runToken from your briefing message first.`;
    case "superseded":
      return `This run no longer owns job ${jobId}: another run took it over or it already closed. Stop working on it and end your turn without further actions; nothing you record now will count.`;
  }
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

/** Attaches a saved file to the job, if `sessionId` is still the job's run. */
export async function attachArtifact(
  workspaceId: string,
  jobId: string,
  artifact: JobArtifact,
  sessionId: string,
): Promise<RunCheck> {
  return patchJobAsRun(workspaceId, jobId, sessionId, (job) =>
    // Already attached: a retried write that had landed.
    job.artifacts.some((existing) => existing.id === artifact.id)
      ? null
      : { ...job, artifacts: [...job.artifacts, artifact] },
  );
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
 * time. A job cancelled mid-run stays cancelled, untouched: the run that was
 * stopped does not get to put its result on it. The cancelled record comes
 * back, so the caller can tell.
 */
export async function completeJob(
  workspaceId: string,
  jobId: string,
  result: JobResult,
  options: { token?: string } = {},
): Promise<Job | null> {
  const state: { outcome: CloseOutcome; cancelled: Job | null } = { outcome: "superseded", cancelled: null };
  const written = await updateDoc<Job>(key(workspaceId, jobId), (current) => {
    if (current === null) return null;
    if (current.status === "cancelled") {
      state.outcome = "cancelled";
      state.cancelled = current;
      return null;
    }
    if (!owns(current, options.token)) {
      state.outcome = "superseded";
      return null;
    }
    state.outcome = "closed";
    const repeats = isRoutine(current);
    return stamp({
      ...current,
      status: repeats ? "scheduled" : "done",
      runAt: repeats ? nextRunAt(current) : current.runAt,
      lease: null,
      result,
      feedback: null,
      error: null,
    });
  });
  const job = written ?? state.cancelled;

  if (job !== null && written !== null && state.outcome === "closed") {
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
      text: `Finished "${job.title}"${result.completion === "recovered" ? " (recovered, unverified)" : ""}${spent(job)}: ${result.summary}`,
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
      text: `Could not finish "${job.title}"${spent(job)}: ${error}`,
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

/**
 * A cancel that held. `session` is the teammate session bound to the run that
 * held the job when it was cancelled, the one to interrupt (null when no run
 * had bound one). `alreadyCancelled` is a job somebody else cancelled before
 * this call; it is still a success, so cancelling twice is harmless and the
 * second call can retry interrupting the run.
 */
export type Cancel =
  | { ok: true; job: Job; wasRunning: boolean; alreadyCancelled: boolean; session: string | null; token: string | null }
  | { ok: false; reason: string };

/**
 * Durably stops a job and its repetition, in one compare-and-set. Finished
 * work is left as it was; a done job cannot be cancelled.
 *
 * The lease goes with it, and with the lease every claim the running bot had:
 * its job writes (`patchJobAsRun`), its side effects (`guardSideEffect`) and
 * its parent's heartbeat (`renewLease`) are refused from the moment this
 * lands, and no close (`completeJob`, `holdForSignoff`, `blockJob`,
 * `sendBack`, `failJob`) can move the job off `cancelled` afterwards. Stopping
 * the bot's session itself is the caller's half; see `cancelJobRun`.
 *
 * Idempotent: a job already cancelled is a success, and the call's own mark on
 * the record tells a retried write that had landed (the Blob SDK can report one
 * as a conflict) from a cancel made by someone else.
 */
export async function cancelJob(workspaceId: string, jobId: string): Promise<Cancel> {
  const mark = { id: newId("cancel"), at: new Date().toISOString() };
  const outcome = {
    reason: `No job ${jobId} in this workspace.`,
    wasRunning: false,
    already: false,
    session: null as string | null,
    token: null as string | null,
  };
  const found: { job: Job | null } = { job: null };
  const read = await updateDoc<Job>(key(workspaceId, jobId), (current) => {
    if (current === null) return null;
    if (current.status === "cancelled") {
      // Ours, if a write that landed was reported as a conflict; else an earlier cancel.
      const mine = current.cancellation?.id === mark.id;
      outcome.already = !mine;
      if (!mine) {
        outcome.session = current.cancellation?.session ?? null;
        outcome.token = current.cancellation?.token ?? null;
      }
      found.job = current;
      return null;
    }
    if (current.status === "done") {
      outcome.reason = unavailable(current);
      return null;
    }
    outcome.wasRunning = current.status === "running";
    // Only a live run's bound session is worth stopping; sessionId may name a past run.
    const lease = current.lease;
    outcome.session = lease !== null && lease.kind === "run" ? (lease.session ?? null) : null;
    // Whatever lease it was, its token names the reservation (if any) the cancel releases.
    outcome.token = lease?.token ?? null;
    return stamp({
      ...current,
      status: "cancelled",
      lease: null,
      everyMinutes: null,
      schedule: null,
      cancellation: { ...mark, session: outcome.session, token: outcome.token },
    });
  });
  const job = read ?? found.job;
  if (job === null) return { ok: false, reason: outcome.reason };

  await markClosed(workspaceId, jobId);
  if (!outcome.already) {
    await record({
      workspaceId,
      kind: "job.cancelled",
      botId: job.botId,
      jobId,
      text: `Cancelled "${job.title}".`,
    });
  }
  return { ok: true, job, wasRunning: outcome.wasRunning, alreadyCancelled: outcome.already, session: outcome.session, token: outcome.token };
}
