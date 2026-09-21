import { defineWorkflowTool } from "eve/tools";
import { sleep } from "workflow";
import { z } from "zod";

import { record, recentActivity } from "../lib/activity";
import { readArtifact } from "../lib/artifacts";
import { getBot } from "../lib/bots";
import { renderBrief } from "../lib/brief";
import { reapIdleScreens } from "../lib/computer/reaper";
import { forgetJob } from "../lib/computer/screens";
import { newId } from "../lib/ids";
import {
  blockJob,
  claimJob,
  completeJob,
  failJob,
  getJob,
  holdForSignoff,
  holdUntilDue,
  patchJob,
  releaseJob,
  renewLease,
  resultIsFromRun,
  sendBack,
  type Hold,
} from "../lib/jobs";
import { sameFindings } from "../lib/findings";
import { jevEnabled, judge } from "../lib/jev";
import { completionQuestions, noteShadow, readVerdict, unmetCriteria } from "../lib/jev-watch";
import { DEFAULT_EFFORT, nextEffort } from "../lib/models";
import { ROUTINE_REPORT_PREFIX } from "../lib/rooms";
import { operator } from "../lib/session";
import { looseBoolean } from "../lib/tool-input";
import type { JobResult, JobStatus } from "../lib/types";

/**
 * Short on purpose, so a run that died is noticed within minutes. A live run
 * renews it on every heartbeat, however long the bot takes.
 */
const LEASE_MS = 20 * 60_000;
const HEARTBEAT = "8m";
const SIGNOFF_TIMEOUT = "24h";
/** Outlives the sign-off wait, so the timeout branch always runs before it lapses. */
const SIGNOFF_LEASE_MS = 25 * 60 * 60_000;
/** A run waits again when its job is rescheduled, but not forever. */
const MAX_WAKES = 20;
/**
 * A routine's run keeps its own schedule, then hands off to a fresh run. Runs
 * finish on the deployment that started them, so a day's bound is how code
 * changes reach a routine; the cycle cap keeps a short interval inside
 * Workflow's per-run event limit.
 */
const HANDOFF_AFTER_MS = 24 * 60 * 60_000;
const MAX_CYCLES = 48;

const JobResultZ = z.object({
  summary: z.string(),
  deliverable: z.string(),
  openQuestions: z.array(z.string()).default([]),
  needsHuman: z.boolean().default(false),
});

type Settled = { ok: true; raw: unknown } | { ok: false; error: string };

/** Subagent failures are not always `Error`s; say what went wrong either way. */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null) {
    const { message, code } = error as { message?: unknown; code?: unknown };
    if (typeof message === "string") return typeof code === "string" ? `${code}: ${message}` : message;
    try {
      return JSON.stringify(error).slice(0, 500);
    } catch {
      // Not serializable either: fall through.
    }
  }
  return String(error);
}

/** One cycle's report for the thread, from a routine that keeps running. */
function cycleReport(title: string, jobId: string, result: JobResult, nextRunAt: string): string {
  return [
    `${ROUTINE_REPORT_PREFIX} "${title}" (${jobId}) finished a cycle and will run again at ${nextRunAt}. Relay only what is new.`,
    "",
    result.summary,
    "",
    result.deliverable.slice(0, 1_200),
    result.openQuestions.length > 0 ? `\nOpen questions:\n${result.openQuestions.map((q) => `- ${q}`).join("\n")}` : "",
  ].join("\n");
}

/**
 * Puts a bot to work.
 *
 * This is a durable background workflow, which is what makes a bot "always on":
 * the operator's conversation continues immediately, the run survives deploys
 * and restarts, and a sign-off request can sit unanswered for a day without
 * holding any compute. One run carries a job through waiting for its start
 * time, the work, revisions a person asks for, and, for a routine, every cycle
 * after that.
 */
export default defineWorkflowTool({
  description:
    "Hand a job to its bot and let it work. Call it right after assign_job for every job, including ones scheduled for later: a job that is not due yet waits for its start time without holding compute, and a routine keeps running on its schedule, reporting after each cycle. Returns immediately with a receipt; results arrive later as task messages. Also re-runs a failed or blocked job.",
  inputSchema: z.object({
    jobId: z.string().describe("The job to run."),
    now: looseBoolean()
      .optional()
      .describe("Start straight away even if the job is scheduled for later."),
  }),
  execution: "background",
  label: {
    start: ({ jobId }) => `Run ${jobId}`,
  },
  async *execute({ jobId, now }, ctx, task) {
    "use workflow";
    const workspaceId = operator(ctx).workspaceId;
    const waitToken = await newWaitToken();
    const startedAt = await clockNow();

    for (let cycle = 1; ; cycle += 1) {
      // 1. Wait. The clock is a durable sleep, not a poller: nothing runs until
      // the job is due, and a job rescheduled meanwhile is simply waited on again.
      if (!(now === true && cycle === 1)) {
        for (let wakes = 0; ; wakes += 1) {
          const hold = await holdForStart(workspaceId, jobId, waitToken);
          if (hold.kind === "due") break;
          if (hold.kind === "refused") {
            return { jobId, ran: cycle > 1, cyclesRun: cycle - 1, reason: hold.reason };
          }
          if (wakes >= MAX_WAKES) {
            return {
              jobId,
              ran: cycle > 1,
              cyclesRun: cycle - 1,
              reason: "It kept being rescheduled; run it again to wait afresh.",
            };
          }
          yield { phase: "scheduled", title: hold.title, runAt: hold.runAt };
          await sleep(new Date(hold.runAt));
        }
      }

      // 2. Work. A person's review, when needed, is the only card this run shows:
      // a run's later cards do not reach the thread, so whatever follows is a new run.
      let signedOff = false;
      let done: { result: JobResult; token: string; title: string; botName: string; previous: string | null } | null = null;
      work: {
        const claim = await claimForRun(workspaceId, jobId, {
          waitToken,
          takeOverWait: now === true && cycle === 1,
        });
        if (!claim.ok) return { jobId, ran: cycle > 1, cyclesRun: cycle - 1, reason: claim.reason };

        yield { phase: claim.revising ? "revising" : "working", bot: claim.botName, title: claim.title };

        const working: Promise<Settled> = ctx
          // No output schema: the result of record is what finish_job stored. A
          // structured final answer is welcome but not required; see salvageResult.
          .agent("teammate", { message: claim.brief })
          .then(
            (raw): Settled => ({ ok: true, raw }),
            (error: unknown): Settled => ({ ok: false, error: describeError(error) }),
          );

        // Heartbeat: while the bot works, keep the lease fresh so the watchdog
        // never mistakes a long job for a dead one and starts a second copy.
        let settled: Settled | null = null;
        while (settled === null) {
          const next = await Promise.race([working, sleep(HEARTBEAT).then(() => null)]);
          if (next !== null) {
            settled = next;
          } else if (!(await keepLease(workspaceId, jobId, claim.token))) {
            return {
              jobId,
              ran: true as const,
              status: "superseded" as const,
              reason: "The job was cancelled or taken over while the bot worked.",
            };
          }
        }

        // What the run left behind, in order of trust: the result finish_job
        // recorded, a structured final answer, or the final answer as text with
        // the files saved along the way. A run that failed outright may still
        // have recorded a result before it did.
        const salvaged = await salvageResult(workspaceId, jobId, claim, settled.ok ? settled.raw : null);
        if (salvaged === null) {
          const error = settled.ok ? "The bot ended without a result: nothing was recorded, said, or saved." : settled.error;
          await markFailed(workspaceId, jobId, error, claim.token);
          return { jobId, ran: true as const, status: "failed" as const, error };
        }
        const result: JobResult = salvaged;

        if (!claim.requiresSignoff && !result.needsHuman) {
          // Observation only: what a grader would have said about this close,
          // recorded beside what actually happened. It decides nothing yet.
          await reviewClose(workspaceId, jobId, claim, result);
          done = { result, token: claim.token, title: claim.title, botName: claim.botName, previous: claim.resultAtClaim };
          break work;
        }
        if (cycle > 1) {
          // A routine's later cycle cannot show a card from this run; a fresh run asks instead.
          const reason = "This cycle needs a person's review.";
          await markBlocked(workspaceId, jobId, reason, claim.token, result);
          return {
            jobId,
            ran: true as const,
            status: "blocked" as const,
            cyclesRun: cycle,
            reason,
            next: "Call run_job for this job again; the fresh run shows the person its review card.",
            result,
          };
        }

        // Blocked with a sign-off lease: the watchdog leaves it alone, and a
        // manual re-run is refused until this request is answered or times out.
        const held = await parkForSignoff(workspaceId, jobId, claim.token, result);
        if (!held) {
          return {
            jobId,
            ran: true as const,
            status: "superseded" as const,
            reason: "The job was cancelled or taken over before sign-off.",
            result,
          };
        }

        yield { phase: "awaiting sign-off", bot: claim.botName, title: claim.title };

        const pending = ctx.ask({
          prompt: [
            claim.requiresSignoff
              ? `${claim.botName} finished "${claim.title}" and needs your sign-off.`
              : `${claim.botName} finished "${claim.title}" but needs you before it counts as done.`,
            "",
            result.summary,
            "",
            result.deliverable.slice(0, 1_500),
            result.openQuestions.length > 0
              ? `\nOpen questions:\n${result.openQuestions.map((q) => `- ${q}`).join("\n")}`
              : "",
          ].join("\n"),
          display: "confirmation",
          allowFreeform: true,
          options: [
            { id: "approve", label: "Approve", style: "primary" },
            { id: "revise", label: "Send back" },
          ],
        });

        // `sleep` is a durable timer, not a setTimeout: nothing is held open
        // while the request sits on the operator's channel.
        const answer = await Promise.race([pending, sleep(SIGNOFF_TIMEOUT).then(() => null)]);

        if (answer === null) {
          await markBlocked(workspaceId, jobId, "Sign-off timed out after 24h.", claim.token, result);
          return { jobId, ran: true as const, status: "blocked" as const, reason: "Sign-off timed out after 24h.", result };
        }
        if (answer.optionId === "approve") {
          signedOff = true;
          done = { result, token: claim.token, title: claim.title, botName: claim.botName, previous: claim.resultAtClaim };
          break work;
        }

        const note = answer.text?.trim() ?? "";
        if (note === "") {
          const reason = "Sent back without a note.";
          await markBlocked(workspaceId, jobId, reason, claim.token, result);
          return {
            jobId,
            ran: true as const,
            status: "blocked" as const,
            reason,
            next: "Ask the person what to change, then call run_job for this job again.",
            result,
          };
        }
        // The revision is a fresh run, so its review card reaches the person: the job
        // goes back in the queue with the note in its brief, next to this result.
        await markSentBack(workspaceId, jobId, note, claim.token, result);
        return {
          jobId,
          ran: true as const,
          status: "sent back" as const,
          note,
          next: "Call run_job for this job now: the note is in its brief and the same bot revises it. Do not open a new job or ask first.",
          result,
        };
      }
      if (done === null) {
        return { jobId, ran: true as const, status: "superseded" as const, reason: "The run ended without a result." };
      }

      // 3. Close.
      const closed = await markDone(workspaceId, jobId, done.result, done.token);
      if (closed.nextRunAt === null) {
        return {
          jobId,
          ran: true as const,
          status: closed.status ?? ("superseded" as const),
          ...(signedOff ? { signedOff: true as const } : {}),
          result: done.result,
        };
      }

      // 4. A routine: report this cycle and keep going, until it is time to
      // hand off to a fresh run.
      if (cycle >= MAX_CYCLES || Date.parse(closed.nextRunAt) - startedAt > HANDOFF_AFTER_MS) {
        return {
          jobId,
          ran: true as const,
          status: "scheduled" as const,
          cyclesRun: cycle,
          nextRunAt: closed.nextRunAt,
          ...(signedOff ? { signedOff: true as const } : {}),
          next: "This routine hands off to a fresh run: call run_job for it again now, and it will wait until nextRunAt.",
          result: done.result,
        };
      }
      // A monitor that finds the same thing again says nothing: the feed keeps
      // the record, and the thread stays worth reading.
      if (sameFindings(done.previous, done.result)) {
        await noteQuietCycle(workspaceId, jobId, done.botName, closed.nextRunAt);
      } else {
        yield task.postMessage(cycleReport(done.title, jobId, done.result, closed.nextRunAt));
      }
    }
  },
});

type Claim =
  | { ok: false; reason: string }
  | {
      ok: true;
      token: string;
      brief: string;
      botName: string;
      title: string;
      requiresSignoff: boolean;
      /** A person sent the last result back; this run revises it. */
      revising: boolean;
      /** The job's result before this run, so a result recorded during it can be told apart. */
      resultAtClaim: string | null;
      /** How many artifacts the job had before this run; anything past them was saved by it. */
      artifactsAtClaim: number;
      /** When this run began, so its progress notes can be told from earlier runs'. */
      startedAt: string;
    };

/**
 * Takes the lease and writes the "started" event.
 *
 * A step, not body code: it touches the clock, generates an id, and writes to
 * storage. Replay reuses the recorded result instead of claiming twice.
 */
async function claimForRun(
  workspaceId: string,
  jobId: string,
  options: { waitToken: string; takeOverWait: boolean },
): Promise<Claim> {
  "use step";
  const job = await getJob(workspaceId, jobId);
  if (job === null) return { ok: false, reason: `No job ${jobId} in this workspace.` };

  const bot = await getBot(workspaceId, job.botId);
  if (bot === null) return { ok: false, reason: "That job's bot is no longer on the roster." };
  if (bot.status === "paused") {
    // Hand a dispatched job back; the watchdog skips paused bots until they resume.
    await releaseJob(workspaceId, jobId);
    return { ok: false, reason: `${bot.name} is paused. Resume them to run this job.` };
  }

  // A job whose last run failed gets another try on a more capable model.
  if (job.status === "failed" && (job.effort ?? DEFAULT_EFFORT) !== "deep") {
    await patchJob(workspaceId, jobId, (current) => ({
      ...current,
      effort: nextEffort(current.effort ?? DEFAULT_EFFORT),
    }));
  }

  const token = newId("lease");
  const claimed = await claimJob(workspaceId, jobId, {
    token,
    forMs: LEASE_MS,
    status: "running",
    kind: "run",
    countAttempt: true,
    waitToken: options.waitToken,
    takeOverWait: options.takeOverWait,
  });
  if (!claimed.ok) return claimed;

  const effort = claimed.job.effort ?? DEFAULT_EFFORT;
  // A job a person sent back carries their note until it closes.
  const revising = Boolean(claimed.job.feedback);
  await record({
    workspaceId,
    kind: "job.started",
    botId: bot.id,
    jobId,
    text: revising
      ? `${bot.name} is revising "${claimed.job.title}" (attempt ${claimed.job.attempts}, ${effort} effort).`
      : `${bot.name} started "${claimed.job.title}" (attempt ${claimed.job.attempts}, ${effort} effort).`,
  });

  return {
    ok: true,
    token,
    brief: renderBrief(bot, claimed.job),
    botName: bot.name,
    title: claimed.job.title,
    requiresSignoff: claimed.job.requiresSignoff,
    revising,
    resultAtClaim: claimed.job.result === null ? null : JSON.stringify(claimed.job.result),
    artifactsAtClaim: claimed.job.artifacts.length,
    startedAt: new Date().toISOString(),
  };
}

const SALVAGE_TEXT_CHARS = 8_000;
const SALVAGE_ARTIFACT_CHARS = 6_000;
const TEXT_MEDIA = /^text\/|json|markdown|csv|xml/i;

/**
 * A result from what the run produced when the Bot did not hand one over.
 *
 * The contract is finish_job. Smaller models do the work, save the summary as
 * a file, and then end with prose, or with nothing, instead of the recorded
 * result; that used to fail the job with the work sitting in an artifact.
 * This assembles the result from what is there, in order of trust: the result
 * finish_job recorded during this run, the final answer if it is the result
 * in JSON, and last the final answer as text plus the text files saved during
 * the run. The result says it was assembled, so nobody mistakes it for a
 * verified close. Null when the run left nothing to assemble.
 */
async function salvageResult(workspaceId: string, jobId: string, claim: Extract<Claim, { ok: true }>, raw: unknown): Promise<JobResult | null> {
  "use step";
  const recorded = await resultRecordedSince(workspaceId, jobId, claim.token, claim.resultAtClaim, claim.startedAt);
  if (recorded !== null) return recorded;

  const text = typeof raw === "string" ? raw.trim() : "";
  if (text.startsWith("{")) {
    try {
      const parsed = JobResultZ.safeParse(JSON.parse(text));
      // The shape is the bot's, but the close is not: it never called finish_job.
      if (parsed.success) return { ...parsed.data, completion: "recovered" };
    } catch {
      // Not the result as JSON; treat it as prose below.
    }
  }

  const job = await getJob(workspaceId, jobId);
  if (job === null || job.lease?.token !== claim.token) return null;
  const saved = job.artifacts.slice(claim.artifactsAtClaim);
  const files: string[] = [];
  let budget = SALVAGE_TEXT_CHARS;
  for (const artifact of saved) {
    if (!TEXT_MEDIA.test(artifact.mediaType) || budget <= 0) {
      files.push(`- ${artifact.name} (${artifact.mediaType}, ${artifact.bytes} bytes)`);
      continue;
    }
    const stored = await readArtifact(artifact.key);
    if (stored === null) continue;
    const content = Buffer.from(stored.base64, "base64").toString("utf8").trim().slice(0, Math.min(SALVAGE_ARTIFACT_CHARS, budget));
    budget -= content.length;
    files.push(`### ${artifact.name}\n${content}`);
  }
  if (text === "" && files.length === 0) return null;

  const notes = await recentActivity(workspaceId, { jobId, after: claim.startedAt, limit: 40 });
  const lastNote = notes.find((event) => event.kind === "job.progress")?.text ?? null;
  const summary = (lastNote ?? text.split(/\n\s*\n/)[0] ?? "").slice(0, 600) || `${claim.botName} ended without a summary; see the deliverable.`;
  const deliverable = [text.slice(0, SALVAGE_TEXT_CHARS), ...files].filter((part) => part !== "").join("\n\n").slice(0, SALVAGE_TEXT_CHARS);

  await record({
    workspaceId,
    kind: "job.progress",
    botId: job.botId,
    jobId,
    text: `${claim.botName} did not close the job with finish_job; the result was assembled from its final message${saved.length > 0 ? ` and ${saved.length} saved file${saved.length === 1 ? "" : "s"}` : ""}.`,
  });
  return {
    summary,
    deliverable,
    openQuestions: [`${claim.botName} did not close this job itself; this result was assembled from what it left. Treat it as unverified.`],
    needsHuman: false,
    completion: "recovered",
  };
}

/**
 * Asks Jev whether the evidence supports the close, and files the answer.
 *
 * Shadow mode: the job closes exactly as it would have. The point is to find
 * out, on this deployment's own jobs, whether the grader agrees with the bots
 * before it is allowed to contradict one.
 */
async function reviewClose(
  workspaceId: string,
  jobId: string,
  claim: Extract<Claim, { ok: true }>,
  result: JobResult,
): Promise<void> {
  "use step";
  if (!jevEnabled()) return;
  const job = await getJob(workspaceId, jobId);
  const criteria = job?.successCriteria ?? [];
  const questions = completionQuestions(criteria);
  const judgement = await judge(
    {
      brief: claim.brief.slice(0, 4_000),
      successCriteria: criteria,
      summary: result.summary,
      deliverable: result.deliverable.slice(0, 4_000),
      openQuestions: result.openQuestions,
      artifacts: (job?.artifacts ?? []).slice(claim.artifactsAtClaim).map((artifact) => artifact.name),
      closedBy: result.completion ?? "unknown",
    },
    questions,
    { timeoutMs: 4_000, workspaceId },
  );
  if (judgement === null) return;
  const overall = readVerdict(judgement, "overall");
  await noteShadow({
    kind: "completion",
    workspaceId,
    jobId,
    verdict: overall.verdict,
    confidence: overall.confidence,
    actual: result.completion ?? "unknown",
    detail: { unmetCriteria: unmetCriteria(judgement, criteria.length), criteria: criteria.length },
  });
}

/** Records a cycle that found nothing new, where the operator can still see it. */
async function noteQuietCycle(workspaceId: string, jobId: string, botName: string, nextRunAt: string): Promise<void> {
  "use step";
  await record({
    workspaceId,
    kind: "job.progress",
    jobId,
    text: `${botName} checked again and found nothing new; next at ${nextRunAt}.`,
  });
}

/** The result the Bot recorded with finish_job during this run, if it recorded one. */
async function resultRecordedSince(
  workspaceId: string,
  jobId: string,
  token: string,
  atClaim: string | null,
  startedAt: string,
): Promise<JobResult | null> {
  "use step";
  const job = await getJob(workspaceId, jobId);
  if (job === null || job.lease?.token !== token || job.result === null) return null;
  return resultIsFromRun(job.result, { startedAt, resultAtClaim: atClaim }) ? job.result : null;
}

async function newWaitToken(): Promise<string> {
  "use step";
  return newId("wait");
}

async function clockNow(): Promise<number> {
  "use step";
  return Date.now();
}

async function holdForStart(workspaceId: string, jobId: string, token: string): Promise<Hold> {
  "use step";
  return holdUntilDue(workspaceId, jobId, token);
}

async function keepLease(workspaceId: string, jobId: string, token: string): Promise<boolean> {
  "use step";
  return renewLease(workspaceId, jobId, token, LEASE_MS);
}

async function parkForSignoff(
  workspaceId: string,
  jobId: string,
  token: string,
  result: JobResult,
): Promise<boolean> {
  "use step";
  const job = await holdForSignoff(workspaceId, jobId, { token, forMs: SIGNOFF_LEASE_MS, result });
  return job !== null;
}

async function markDone(
  workspaceId: string,
  jobId: string,
  result: JobResult,
  token: string,
): Promise<{ status: JobStatus | null; nextRunAt: string | null }> {
  "use step";
  const job = await completeJob(workspaceId, jobId, result, { token });
  // A handover this job raised is over with it.
  await forgetJob(workspaceId, jobId).catch(() => undefined);
  // Browsers nobody is using are stopped; they start again on the next use.
  await reapIdleScreens().catch(() => 0);
  const repeats = job?.status === "scheduled";
  return { status: job?.status ?? null, nextRunAt: repeats ? (job?.runAt ?? null) : null };
}

async function markFailed(
  workspaceId: string,
  jobId: string,
  error: string,
  token: string,
): Promise<void> {
  "use step";
  await failJob(workspaceId, jobId, error, { token });
  await forgetJob(workspaceId, jobId).catch(() => undefined);
  await reapIdleScreens().catch(() => 0);
}

async function markBlocked(
  workspaceId: string,
  jobId: string,
  note: string,
  token: string,
  result: JobResult,
): Promise<void> {
  "use step";
  await blockJob(workspaceId, jobId, note, { token, result });
}

async function markSentBack(
  workspaceId: string,
  jobId: string,
  note: string,
  token: string,
  result: JobResult,
): Promise<void> {
  "use step";
  await sendBack(workspaceId, jobId, note, { token, result });
  await forgetJob(workspaceId, jobId).catch(() => undefined);
}
