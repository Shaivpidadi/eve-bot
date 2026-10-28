import { defineWorkflowTool, type WorkflowServeContext } from "eve/tools";
import { sleep } from "workflow";
import { z } from "zod";

import { record, recentActivity } from "../lib/activity";
import { artifactBytes, readArtifact } from "../lib/artifacts";
import { getBot } from "../lib/bots";
import { admitClaimedRun, BUDGET_HALT_REASON, releaseRun, runHalted, settleRun } from "../lib/budget";
import { chargeComputerRuntimeSoon } from "../lib/computer-spend";
import { renderBrief } from "../lib/brief";
import type { Engine, HarnessEngine } from "../lib/engines";
import { reapIdleScreens } from "../lib/computer/reaper";
import { forgetJob } from "../lib/computer/screens";
import { newId } from "../lib/ids";
import { DISPATCH_LEASE_MS, dueMessage } from "../lib/dispatch";
import { enqueue } from "../lib/outbox";
import { flushOutboxSoon } from "../lib/self";
import {
  blockJob,
  cancelJob,
  claimJob,
  completeJob,
  failJob,
  getJob,
  handOffWait,
  holdForSignoff,
  holdUntilDue,
  patchJob,
  releaseJob,
  renewLease,
  resultIsFromRun,
  runStanding,
  sendBack,
  type Hold,
  type Standing,
} from "../lib/jobs";
import { learnFromFeedback } from "../lib/memory/outcomes";
import { sameFindings } from "../lib/findings";
import { jevEnabled, judge } from "../lib/jev";
import { completionQuestions, noteShadow, readVerdict, unmetCriteria } from "../lib/jev-watch";
import { explainGatewayError } from "../lib/gateway-errors";
import { DEFAULT_EFFORT, nextEffort } from "../lib/models";
import { ROUTINE_REPORT_PREFIX } from "../lib/rooms";
import { nextWake } from "../lib/run-stop";
import { operator } from "../lib/session";
import { looseBoolean } from "../lib/tool-input";
import type { JobResult, JobStatus } from "../lib/types";

/**
 * Short on purpose, so a run that died is noticed within minutes. A live run
 * renews it every few checks, however long the bot takes.
 */
const LEASE_MS = 20 * 60_000;
/**
 * How often a run waiting on its bot looks at its job: a cancelled or halted
 * job's Bot is stopped within this, even while it is parked on a card. A look
 * is two reads; the lease, a write, is renewed only every `RENEW_EVERY` looks
 * (8 minutes).
 */
const CHECK_EVERY = "20s";
const RENEW_EVERY = 24;
const SIGNOFF_TIMEOUT = "24h";
/** Outlives the sign-off wait, so the timeout branch always runs before it lapses. */
const SIGNOFF_LEASE_MS = 25 * 60 * 60_000;
/** A run waits again when its job is rescheduled, but not forever. */
const MAX_WAKES = 20;
/** How often a run retries a budget it could not check before leaving the job to the watchdog. */
const MAX_DEFERRALS = 5;

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
/**
 * Puts a bot to work.
 *
 * A durable workflow, which is what makes a bot "always on": the run survives
 * deploys and restarts, and a sign-off request can sit unanswered for a day
 * without holding any compute. Each call is one resumable task (eve 0.79):
 *
 * - A job that is due runs now, inside the call: the conversation shows it
 *   working, the Bot's questions, approvals and takeovers reach the person, and
 *   the result comes back to the model as the call's result.
 * - A job that is not due yet is answered at once, which frees the
 *   conversation; the task then sleeps, idle, until the start time and posts
 *   "Job … is due" into the room, exactly as the watchdog does, so the next
 *   call runs it.
 * - A routine runs one cycle per call, answers, then waits for its next cycle
 *   the same way.
 *
 * An idle task holds no turn, so a thread with routines does not stay busy.
 */
export default defineWorkflowTool({
  description:
    "Hand a job to its bot and let it work. Call it right after assign_job for every job, including ones scheduled for later. A job that is due runs now and its result comes back to you. A job scheduled for later is answered at once and waits for its start time without holding this conversation; when it is due, this thread receives \"Job … is due\" and you call run_job for it again. A routine runs one cycle per call and is woken the same way for the next. Also re-runs a failed or blocked job.",
  inputSchema: z.object({
    jobId: z.string().describe("The job to run."),
    now: looseBoolean()
      .optional()
      .describe("Start straight away even if the job is scheduled for later."),
    note: z
      .string()
      .max(2_000)
      .optional()
      .describe("What the person wants changed, when they sent the job back without saying and you asked: the same bot revises with it."),
  }),
  label: {
    start: ({ jobId }) => `Run ${jobId}`,
  },
  async serve(receive, ctx) {
    "use workflow";
    const call = await receive();
    const { jobId, now, note } = call.input;
    const workspaceId = operator(ctx).workspaceId;
    if (note !== undefined && note.trim() !== "") await takeNote(workspaceId, jobId, note.trim());

    // 1. Not due yet: answer now, then wait for the start time without holding the conversation.
    if (now !== true) {
      const waitToken = await newWaitToken();
      const hold = await holdForStart(workspaceId, jobId, waitToken);
      if (hold.kind === "refused") {
        ctx.reply({ jobId, ran: false as const, reason: hold.reason });
        return;
      }
      if (hold.kind === "wait") {
        ctx.reply({
          jobId,
          ran: false as const,
          status: "scheduled" as const,
          runAt: hold.runAt,
          note: "Waiting for its start time without holding this conversation. When it is due, this thread receives \"Job … is due\": call run_job for it then.",
        });
        await waitThenWake(workspaceId, jobId, waitToken, hold.runAt);
        return;
      }
    }

    // 2. Due: run one cycle inside this call.
    const outcome = await runCycle(workspaceId, jobId, now === true, call.abortSignal, ctx);
    if (outcome.kind === "reply") {
      ctx.reply(outcome.reply);
      return;
    }

    // 3. A routine: answer this cycle, then wait for the next one, idle.
    ctx.reply(outcome.reply);
    const waitToken = await newWaitToken();
    const hold = await holdForStart(workspaceId, jobId, waitToken);
    if (hold.kind === "wait") await waitThenWake(workspaceId, jobId, waitToken, hold.runAt);
    else if (hold.kind === "due") await wakeRoom(workspaceId, jobId, waitToken);
  },
});

/** Sleeps until the job's start time, following reschedules, then wakes its room. */
async function waitThenWake(workspaceId: string, jobId: string, waitToken: string, firstRunAt: string): Promise<void> {
  let runAt = firstRunAt;
  for (let wakes = 0; wakes < MAX_WAKES; wakes += 1) {
    await sleep(new Date(runAt));
    const hold = await holdForStart(workspaceId, jobId, waitToken);
    if (hold.kind === "refused") return;
    if (hold.kind === "due") {
      await wakeRoom(workspaceId, jobId, waitToken);
      return;
    }
    runAt = hold.runAt;
  }
  // Rescheduled too many times: the watchdog picks it up once this wait lapses.
}

type CycleOutcome =
  /** The call's answer, and nothing to wait for. */
  | { readonly kind: "reply"; readonly reply: Record<string, unknown> }
  /** A routine's cycle: answer, then wait for the next one. */
  | { readonly kind: "routine"; readonly reply: Record<string, unknown> };

const answer = (reply: Record<string, unknown>): CycleOutcome => ({ kind: "reply", reply });

/** One cycle of work: claim, the Bot's turn, sign-off when needed, close. */
async function runCycle(
  workspaceId: string,
  jobId: string,
  startNow: boolean,
  abortSignal: AbortSignal,
  ctx: WorkflowServeContext,
): Promise<CycleOutcome> {
  const waitToken = await newWaitToken();
  let signedOff = false;
  let claim = await claimForRun(workspaceId, jobId, { waitToken, takeOverWait: startNow, deferrals: 0 });
  // The budget could not be checked: the claim went back and the job waits under
  // this wait token. Sleep and try again, a few times, then leave it to the watchdog.
  for (let deferrals = 1; !claim.ok && claim.retryAt !== null; deferrals += 1) {
    if (deferrals > MAX_DEFERRALS) {
      return answer({ jobId, ran: false, reason: `${claim.reason} The job is waiting; the watchdog will try it again.` });
    }
    await sleep(new Date(claim.retryAt));
    claim = await claimForRun(workspaceId, jobId, { waitToken, takeOverWait: false, deferrals });
  }
  if (!claim.ok) return answer({ jobId, ran: false, reason: claim.reason });

  // A cancel that landed between the claim and here: the bot never starts.
  const beforeWork = await standing(workspaceId, jobId, claim.token);
  if (beforeWork !== "owns") {
    await closeBudget(workspaceId, claim.token, "release");
    return answer(stoppedEarly(jobId, beforeWork));
  }

  // The Bot's turn stops when this call is cancelled from eve, or when a look
  // below finds the job stopped: the one handle on the child eve gives.
  const stop = new AbortController();
  if (abortSignal.aborted) stop.abort();
  else abortSignal.addEventListener("abort", () => stop.abort(), { once: true });

  // A Bot on another engine (lib/engines): its session runs outside this
  // workflow, so `working` never settles on its own; each look below asks the
  // session instead, and every way out of the run stops it.
  const engine: Engine = claim.engine ?? "eve";
  let harness: { readonly engine: HarnessEngine; readonly sessionId: string; cursor: string | null; charged: number; partial: string } | null = null;
  let settledEarly: Settled | null = null;
  if (engine !== "eve") {
    const started = await startHarness(engine, workspaceId, jobId, claim.token, claim.brief);
    if (started.ok) harness = { engine, sessionId: started.sessionId, cursor: null, charged: 0, partial: "" };
    else settledEarly = { ok: false, error: started.error };
  }
  // What the session spent is charged as it goes (each look) and once more when it stops.
  const spendOf = (session: { readonly sessionId: string; readonly charged: number }) => ({
    workspaceId,
    jobId,
    botId: claim.botId ?? "",
    token: claim.token,
    sessionId: session.sessionId,
    charged: session.charged,
  });
  const halt = async (): Promise<void> => {
    stop.abort();
    if (harness !== null) await stopHarness(harness.engine, spendOf(harness));
  };

  // No output schema: the result of record is what finish_job stored. A
  // structured final answer is welcome but not required; see salvageResult.
  const working: Promise<Settled> =
    engine !== "eve"
      ? settledEarly !== null
        ? Promise.resolve(settledEarly)
        : new Promise<Settled>(() => undefined)
      : ctx
          .agent("teammate")
          .send(claim.brief, { signal: stop.signal })
          .then((response) => response.result())
          .then(
            (result): Settled =>
              result.status === "failed" ? { ok: false, error: result.error?.message ?? "The bot's turn failed." } : { ok: true, raw: result.data ?? result.reply ?? null },
            (error: unknown): Settled => ({ ok: false, error: describeError(error) }),
          );

  // Heartbeat: while the bot works, look at the job every 20 seconds and keep
  // the lease fresh, so the watchdog never mistakes a long job for a dead one
  // and starts a second copy. A look that finds the job cancelled, taken over,
  // or halted by the budget cancels the Bot's turn; the Bot's model resolver
  // refuses its next step on its own as well (see the teammate's lib/stops.ts).
  let settled: Settled | null = null;
  let looks = 0;
  while (settled === null) {
    const wake = await nextWake(working, sleep(CHECK_EVERY));
    if (wake.kind === "settled") {
      settled = wake.settled;
      continue;
    }
    looks += 1;
    const still =
      looks % RENEW_EVERY === 0 ? await keepLease(workspaceId, jobId, claim.token) : (await standing(workspaceId, jobId, claim.token)) === "owns";
    if (!still) {
      await halt();
      await closeBudget(workspaceId, claim.token, "release");
      return answer(stoppedEarly(jobId, await standing(workspaceId, jobId, claim.token)));
    }
    // The budget halted the run: its model resolver refuses the next step, and this stops the turn outright.
    const halted = await budgetHalted(workspaceId, claim.token);
    if (halted !== null) {
      await halt();
      if (harness !== null) settled = { ok: false, error: halted };
      continue;
    }
    // Stopped from eve while a harness session works: nothing aborts that session but this.
    if (harness !== null && abortSignal.aborted) {
      await halt();
      settled = { ok: false, error: "Stopped." };
      continue;
    }
    if (harness !== null) {
      const { look, charged, halt: overBudget } = await lookAtHarness(harness.engine, harness.cursor, harness.partial, spendOf(harness));
      harness.charged = charged;
      harness.partial = look.partial;
      // Spend is read from the session's log at every look (H0), so a run over the budget stops here, mid-turn.
      if (overBudget !== null) {
        await halt();
        settled = { ok: false, error: overBudget };
        continue;
      }
      if (look.kind === "working") harness.cursor = look.cursor;
      else settled = look.ok ? { ok: true, raw: null } : { ok: false, error: look.error };
    }
  }
  // The turn is over one way or another: a harness session never outlives its run.
  if (harness !== null) await stopHarness(harness.engine, spendOf(harness));

  // Stopped from eve (a task cancel, or the conversation started over): the job is cancelled too.
  if (abortSignal.aborted && !stop.signal.aborted) stop.abort();
  if (abortSignal.aborted) {
    await cancelFromEve(workspaceId, jobId, claim.token);
    await closeBudget(workspaceId, claim.token, "release");
    return answer(stoppedEarly(jobId, "cancelled"));
  }

  // A cancel can land while the bot works, and stopping its session is one way
  // the child returns at all: whatever it left is not this job's result any more.
  const afterWork = await standing(workspaceId, jobId, claim.token);
  if (afterWork !== "owns") {
    await closeBudget(workspaceId, claim.token, "release");
    return answer(stoppedEarly(jobId, afterWork));
  }

  // The budget stopped the bot mid-run (see the teammate's usage hook): the job
  // waits for a person with the reason, rather than failing.
  // An AI Gateway budget that ran out stops it the same way.
  const gateway = settled.ok ? null : explainGatewayError(settled.error);
  const budgetStop = settled.ok ? null : ((await budgetHalted(workspaceId, claim.token)) ?? (gateway?.kind === "budget" ? gateway.text : null));
  if (budgetStop !== null) {
    await markBlocked(workspaceId, jobId, budgetStop, claim.token);
    return answer({ jobId, ran: true, status: "blocked", reason: budgetStop });
  }

  // What the run left behind, in order of trust: the result finish_job
  // recorded, a structured final answer, or the final answer as text with the
  // files saved along the way.
  const salvaged = await salvageResult(workspaceId, jobId, claim, settled.ok ? settled.raw : null);
  if (salvaged === null) {
    const error = settled.ok ? "The bot ended without a result: nothing was recorded, said, or saved." : (gateway?.text ?? settled.error);
    const nextCycle = await markFailed(workspaceId, jobId, error, claim.token);
    // A routine lost only this cycle: say when it runs again, so nobody starts it over.
    if (nextCycle !== null) return answer({ jobId, ran: true, status: "scheduled", error, nextRunAt: nextCycle, note: "This cycle failed; the routine keeps its schedule. Do not create it again." });
    return answer({ jobId, ran: true, status: "failed", error });
  }
  const result: JobResult = salvaged;

  if (claim.requiresSignoff || result.needsHuman) {
    // Blocked with a sign-off lease: the watchdog leaves it alone, and a manual
    // re-run is refused until this request is answered or times out.
    const held = await parkForSignoff(workspaceId, jobId, claim.token, result);
    if (!held) {
      await closeBudget(workspaceId, claim.token, "release");
      return answer({ jobId, ran: true, status: "superseded", reason: "The job was cancelled or taken over before sign-off.", result });
    }

    const pending = ctx.ask({
      prompt: [
        claim.requiresSignoff
          ? `${claim.botName} finished "${claim.title}" and needs your sign-off.`
          : `${claim.botName} finished "${claim.title}" but needs you before it counts as done.`,
        "",
        result.summary,
        "",
        result.deliverable.slice(0, 1_500),
        result.openQuestions.length > 0 ? `\nOpen questions:\n${result.openQuestions.map((q) => `- ${q}`).join("\n")}` : "",
      ].join("\n"),
      display: "confirmation",
      allowFreeform: true,
      options: [
        { id: "approve", label: "Approve", style: "primary" },
        { id: "revise", label: "Send back" },
      ],
    });

    // `sleep` is a durable timer: nothing is held open while the request sits on the channel.
    const response = await Promise.race([pending, sleep(SIGNOFF_TIMEOUT).then(() => null)]);
    // A cancel while the card waited: the answer no longer decides anything.
    const afterCard = await standing(workspaceId, jobId, claim.token);
    if (afterCard !== "owns") return answer(stoppedEarly(jobId, afterCard));

    if (response === null || response.status !== "answered") {
      const reason = response === null ? "Sign-off timed out after 24h." : "The sign-off request was withdrawn.";
      await markBlocked(workspaceId, jobId, reason, claim.token, result);
      return answer({ jobId, ran: true, status: "blocked", reason, result });
    }
    if (response.optionId === "approve") {
      signedOff = true;
    } else {
      const note = response.text?.trim() ?? "";
      if (note === "") {
        const reason = "Sent back without a note.";
        await markBlocked(workspaceId, jobId, reason, claim.token, result);
        return answer({ jobId, ran: true, status: "blocked", reason, next: "Ask the person what to change, then call run_job for this job again with their answer as `note`. Do not open a new job for it.", result });
      }
      // The revision is a fresh call, so its review card reaches the person: the job
      // goes back in the queue with the note in its brief, next to this result.
      await markSentBack(workspaceId, jobId, note, claim.token, result);
      return answer({
        jobId,
        ran: true,
        status: "sent back",
        note,
        next: "Call run_job for this job now: the note is in its brief and the same bot revises it. Do not open a new job or ask first.",
        result,
      });
    }
  } else {
    // Observation only: what a grader would have said about this close,
    // recorded beside what actually happened. It decides nothing yet.
    await reviewClose(workspaceId, jobId, claim, result);
  }

  // Close.
  const closed = await markDone(workspaceId, jobId, result, claim.token);
  // Cancelled after the work (during sign-off, say): completeJob left it cancelled.
  if (closed.status === "cancelled") return answer(stoppedEarly(jobId, "cancelled"));
  if (closed.nextRunAt === null) {
    return answer({ jobId, ran: true, status: closed.status ?? "superseded", ...(signedOff ? { signedOff: true } : {}), result });
  }

  // A routine. A monitor that finds the same thing again says nothing: the feed
  // keeps the record, and the thread stays worth reading.
  if (sameFindings(claim.resultAtClaim, result)) {
    await noteQuietCycle(workspaceId, jobId, claim.botName, closed.nextRunAt);
    return {
      kind: "routine",
      reply: { jobId, ran: true, status: "scheduled", nextRunAt: closed.nextRunAt, quiet: true, note: "Nothing new this cycle: say nothing to the person." },
    };
  }
  return {
    kind: "routine",
    reply: {
      jobId,
      ran: true,
      status: "scheduled",
      nextRunAt: closed.nextRunAt,
      ...(signedOff ? { signedOff: true } : {}),
      report: cycleReport(claim.title, jobId, result, closed.nextRunAt),
      result,
    },
  };
}

/** The run's answer when it finds the job is no longer its own: nothing recorded. */
function stoppedEarly(jobId: string, standing: Standing) {
  return standing === "cancelled"
    ? { jobId, ran: true as const, status: "cancelled" as const, reason: "The job was cancelled; this run recorded nothing for it." }
    : {
        jobId,
        ran: true as const,
        status: "superseded" as const,
        reason: "The job was taken over or closed while the bot worked; this run recorded nothing.",
      };
}

type Claim =
  /** Not run. `retryAt` is set when the claim was handed back to be tried again then (see `admitClaimedRun`). */
  | { ok: false; reason: string; retryAt: string | null; title: string }
  | {
      ok: true;
      token: string;
      brief: string;
      /**
       * What runs this job: eve, or a harness engine the owner turned on
       * (lib/engines). Absent in a claim recorded before engines existed,
       * which a run in flight across the upgrade replays: that is eve.
       */
      engine?: Engine;
      /** Absent in a claim recorded before engines existed; only harness runs need it. */
      botId?: string;
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
  options: { waitToken: string; takeOverWait: boolean; deferrals: number },
): Promise<Claim> {
  "use step";
  const job = await getJob(workspaceId, jobId);
  if (job === null) return { ok: false, reason: `No job ${jobId} in this workspace.`, retryAt: null, title: "" };
  const refused = (reason: string): Claim => ({ ok: false, reason, retryAt: null, title: job.title });

  const bot = await getBot(workspaceId, job.botId);
  if (bot === null) return refused("That job's bot is no longer on the roster.");
  if (bot.status === "paused") {
    // Hand a dispatched job back; the watchdog skips paused bots until they resume.
    await releaseJob(workspaceId, jobId);
    return refused(`${bot.name} is paused. Resume them to run this job.`);
  }
  // Checked again at every run, so a data control turned on since the Bot was set up stops it here.
  const [{ engineOf, engineRefusal }, { effectiveEnv }] = await Promise.all([import("../lib/engines"), import("../lib/settings/store")]);
  const engine = engineOf(bot);
  const engineRefused = engineRefusal(engine, { workspaceId, env: await effectiveEnv(workspaceId) });
  if (engineRefused !== null) {
    await releaseJob(workspaceId, jobId);
    return refused(`${bot.name} runs on another engine that cannot run here: ${engineRefused}`);
  }

  // A job whose last run failed gets another try on a more capable model,
  // unless the next effort runs on the same model (all on one free model, say).
  // Loaded here, inside the step: the store it reads stays out of the workflow bundle.
  const { runModel, sameModelNext } = await import("../lib/model-settings");
  if (job.status === "failed" && (job.effort ?? DEFAULT_EFFORT) !== "deep" && !(await sameModelNext(workspaceId, job.effort ?? DEFAULT_EFFORT))) {
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
  if (!claimed.ok) return refused(claimed.reason);

  // Each claim is its own reservation under its own token, so a routine's
  // cycles and a job's retries each answer to the workspace budget afresh.
  // Refused: the job is blocked with the reason, fenced on this token.
  // Unchecked: the claim goes back and this run retries at `retryAt`.
  // The computer's sessions that finished since the last sweep count before this run is admitted.
  await chargeComputerRuntimeSoon();
  // The model this run runs on, chosen now and written into its brief (see `renderBrief`).
  const model = await runModel(workspaceId, claimed.job.effort ?? DEFAULT_EFFORT);
  const admission = await admitClaimedRun(workspaceId, claimed.job, token, {
    waitToken: options.waitToken,
    deferrals: options.deferrals,
    freeModel: model?.free === true,
  });
  if (!admission.admitted) return { ok: false, reason: admission.reason, retryAt: admission.retryAt, title: claimed.job.title };

  // A run that inherits a journal continues it; the console and the metrics read where from.
  const resumedFrom = (claimed.job.journal ?? []).length;
  if ((claimed.job.resumedFrom ?? 0) !== resumedFrom) {
    await patchJob(workspaceId, jobId, (current) => ({ ...current, resumedFrom }));
  }

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
      : resumedFrom > 0
        ? `${bot.name} is continuing "${claimed.job.title}" from step ${resumedFrom} (attempt ${claimed.job.attempts}, ${effort} effort).`
        : `${bot.name} started "${claimed.job.title}" (attempt ${claimed.job.attempts}, ${effort} effort).`,
    ...(resumedFrom > 0 ? { data: { resumedFrom } } : {}),
  });

  return {
    ok: true,
    token,
    brief: engine === "eve" ? renderBrief(bot, claimed.job, { token, model }) : (await import("../lib/engines/brief")).renderHarnessBrief(bot, claimed.job),
    engine,
    botId: bot.id,
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
  // Data the bot ended on (a tool's answer echoed back), which makes no summary.
  let bareData = false;
  if (text.startsWith("{")) {
    try {
      const value: unknown = JSON.parse(text);
      bareData = true;
      const parsed = JobResultZ.safeParse(value);
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
    const bytes = stored === null ? null : await artifactBytes(stored);
    if (bytes === null) continue;
    const content = Buffer.from(bytes).toString("utf8").trim().slice(0, Math.min(SALVAGE_ARTIFACT_CHARS, budget));
    budget -= content.length;
    files.push(`### ${artifact.name}\n${content}`);
  }
  if (text === "" && files.length === 0) return null;

  const notes = await recentActivity(workspaceId, { jobId, after: claim.startedAt, limit: 40 });
  const lastNote = notes.find((event) => event.kind === "job.progress")?.text ?? null;
  const summary = (lastNote ?? (bareData ? "" : text.split(/\n\s*\n/)[0]) ?? "").slice(0, 600) || `${claim.botName} ended without a summary; see the deliverable.`;
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
  const decisions = (job?.journal ?? []).filter((entry) => entry.kind === "decision").map((entry) => entry.text);
  const questions = completionQuestions(criteria, decisions);
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
    { timeoutMs: 4_000, workspaceId, runToken: claim.token },
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
    detail: {
      unmetCriteria: unmetCriteria(judgement, criteria.length),
      criteria: criteria.length,
      decisions: decisions.length,
      ...(decisions.length > 0 ? { decisionsAgree: readVerdict(judgement, "decisions").verdict } : {}),
    },
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

/**
 * The result the Bot recorded with finish_job during this run, if it recorded one.
 * finish_job stamps the run's token on the result, so a run that outlived its
 * lease can never pass off its result as this one's.
 */
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
  return resultIsFromRun(job.result, { token, startedAt, resultAtClaim: atClaim }) ? job.result : null;
}

async function newWaitToken(): Promise<string> {
  "use step";
  return newId("wait");
}

/** Starts the run's harness session and binds it to the run. Steps load durable-harness; the workflow body never does. */
async function startHarness(engine: HarnessEngine, workspaceId: string, jobId: string, token: string, brief: string) {
  "use step";
  const { startHarnessRun } = await import("../lib/engines/sessions");
  return startHarnessRun(engine, { workspaceId, jobId, token, brief });
}

interface HarnessCharge {
  readonly workspaceId: string;
  readonly jobId: string;
  readonly botId: string;
  readonly token: string;
  readonly sessionId: string;
  /** How many of the session's priced calls are charged already. */
  readonly charged: number;
}

/**
 * One look at the session's turn: charges what it spent since the last, and
 * puts what the model wrote into the Bot's thread. `partial` is the text the
 * last look caught mid-stretch, which this one goes on with.
 */
async function lookAtHarness(engine: HarnessEngine, cursor: string | null, partial: string, charge: HarnessCharge) {
  "use step";
  const { chargeHarnessSpend, lookAtHarnessRun, tellThread } = await import("../lib/engines/sessions");
  const look = await lookAtHarnessRun(engine, charge.sessionId, cursor, undefined, partial);
  const { charged, halted } = await chargeHarnessSpend({ ...charge, spend: look.spend });
  await tellThread({ ...charge, heard: look.heard, said: look.said }).catch(() => undefined);
  // The reason as words, from here: the workflow body must not reach into the budget module itself.
  return { look: { ...look, spend: [], said: [] }, charged, halt: halted ? BUDGET_HALT_REASON : null };
}

/** Charges what is left, then stops the session for good (closes it, deletes its Sandbox and Drive). */
async function stopHarness(engine: HarnessEngine, charge: HarnessCharge): Promise<void> {
  "use step";
  const { chargeHarnessSpend, lookAtHarnessRun, stopHarnessRun } = await import("../lib/engines/sessions");
  const last = await lookAtHarnessRun(engine, charge.sessionId, null).catch(() => null);
  if (last !== null) await chargeHarnessSpend({ ...charge, spend: last.spend }).catch(() => undefined);
  await stopHarnessRun(engine, charge.sessionId);
}


/**
 * The start time came: hand the wait over as a dispatch, exactly as the
 * watchdog does, and wake the room with the same message, so the `run_job`
 * call that follows takes the job. Delivered at once when the server can call
 * itself, else by the console's poll or the watchdog (see `lib/outbox.ts`).
 */
async function wakeRoom(workspaceId: string, jobId: string, waitToken: string): Promise<void> {
  "use step";
  const job = await handOffWait(workspaceId, jobId, waitToken, { token: newId("dispatch"), forMs: DISPATCH_LEASE_MS });
  if (job === null) return;
  await enqueue({ workspaceId, room: job.room, message: dueMessage(job) });
  await flushOutboxSoon();
}

/** eve stopped the run (a task cancel, or the room started over): cancel the job with it. */
async function cancelFromEve(workspaceId: string, jobId: string, token: string): Promise<void> {
  "use step";
  if ((await runStanding(workspaceId, jobId, token)) === "owns") await cancelJob(workspaceId, jobId);
}

async function holdForStart(workspaceId: string, jobId: string, token: string): Promise<Hold> {
  "use step";
  return holdUntilDue(workspaceId, jobId, token);
}

async function standing(workspaceId: string, jobId: string, token: string): Promise<Standing> {
  "use step";
  return runStanding(workspaceId, jobId, token);
}

async function keepLease(workspaceId: string, jobId: string, token: string): Promise<boolean> {
  "use step";
  return renewLease(workspaceId, jobId, token, LEASE_MS);
}

/**
 * Closes the run's budget reservation: `settle` when the run finished its
 * part, `release` when it was cancelled or superseded. Both are idempotent
 * and harmless on a reservation already closed. Best effort: a reservation
 * left held is released by `repairReservations` once the lease is gone.
 *
 * The close steps below (`markDone`, `markFailed`, `markBlocked`,
 * `parkForSignoff`, `markSentBack`) do the same inline: a plain helper shared
 * with them would pull the store into the workflow bundle.
 */
async function closeBudget(workspaceId: string, token: string, how: "settle" | "release"): Promise<void> {
  "use step";
  await (how === "settle" ? settleRun(workspaceId, token) : releaseRun(workspaceId, token)).catch(() => false);
}

/** The reason to block with when the budget halted this run, else null. A step, so the workflow body never loads the budget. */
async function budgetHalted(workspaceId: string, token: string): Promise<string | null> {
  "use step";
  return (await runHalted(workspaceId, token).catch(() => false)) ? BUDGET_HALT_REASON : null;
}

async function parkForSignoff(
  workspaceId: string,
  jobId: string,
  token: string,
  result: JobResult,
): Promise<boolean> {
  "use step";
  const job = await holdForSignoff(workspaceId, jobId, { token, forMs: SIGNOFF_LEASE_MS, result });
  // The work is over; waiting on a person spends nothing.
  if (job !== null) await settleRun(workspaceId, token).catch(() => false);
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
  // Null: another run holds the job now. Cancelled: a person stopped it.
  await (job === null || job.status === "cancelled" ? releaseRun(workspaceId, token) : settleRun(workspaceId, token)).catch(() => false);
  // A handover this job raised is over with it.
  await forgetJob(workspaceId, jobId).catch(() => undefined);
  // Browsers nobody is using are stopped; they start again on the next use.
  await reapIdleScreens().catch(() => 0);
  const repeats = job?.status === "scheduled";
  return { status: job?.status ?? null, nextRunAt: repeats ? (job?.runAt ?? null) : null };
}

/**
 * The person's note for a job they sent back without one (or that failed or is
 * blocked): it goes in the brief of the next run, as a note on the card does.
 */
async function takeNote(workspaceId: string, jobId: string, note: string): Promise<void> {
  "use step";
  await patchJob(workspaceId, jobId, (job) => (job.status === "blocked" || job.status === "failed" ? { ...job, feedback: note } : job));
}

async function markFailed(
  workspaceId: string,
  jobId: string,
  error: string,
  token: string,
): Promise<string | null> {
  "use step";
  const failed = await failJob(workspaceId, jobId, error, { token, routineGoesOn: true });
  await (failed === null ? releaseRun(workspaceId, token) : settleRun(workspaceId, token)).catch(() => false);
  await forgetJob(workspaceId, jobId).catch(() => undefined);
  await reapIdleScreens().catch(() => 0);
  // When the routine runs again, if this was a routine's cycle.
  return failed?.status === "scheduled" ? failed.runAt : null;
}

async function markBlocked(
  workspaceId: string,
  jobId: string,
  note: string,
  token: string,
  result?: JobResult,
): Promise<void> {
  "use step";
  const blocked = await blockJob(workspaceId, jobId, note, { token, ...(result === undefined ? {} : { result }) });
  await (blocked === null ? releaseRun(workspaceId, token) : settleRun(workspaceId, token)).catch(() => false);
}

async function markSentBack(
  workspaceId: string,
  jobId: string,
  note: string,
  token: string,
  result: JobResult,
): Promise<void> {
  "use step";
  const sent = await sendBack(workspaceId, jobId, note, { token, result });
  await (sent === null ? releaseRun(workspaceId, token) : settleRun(workspaceId, token)).catch(() => false);
  await forgetJob(workspaceId, jobId).catch(() => undefined);
  // A person saying what to change is the clearest statement of how they want work done.
  await learnFromFeedback(workspaceId, jobId, note, result);
}
