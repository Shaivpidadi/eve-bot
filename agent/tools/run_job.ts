import { defineWorkflowTool } from "eve/tools";
import { sleep } from "workflow";
import { z } from "zod";

import { record } from "../lib/activity";
import { getBot } from "../lib/bots";
import { JOB_RESULT_SCHEMA, renderBrief } from "../lib/brief";
import { newId } from "../lib/ids";
import { blockJob, claimJob, completeJob, failJob, getJob, patchJob } from "../lib/jobs";
import { operator } from "../lib/session";
import type { JobResult } from "../lib/types";

const LEASE_MS = 60 * 60 * 1_000;
const SIGNOFF_TIMEOUT = "24h";

const JobResultZ = z.object({
  summary: z.string(),
  deliverable: z.string(),
  openQuestions: z.array(z.string()).default([]),
  needsHuman: z.boolean().default(false),
});

/**
 * Puts a bot to work.
 *
 * This is a durable background workflow, which is what makes a bot "always on":
 * the operator's conversation continues immediately, the run survives deploys
 * and restarts, and a sign-off request can sit unanswered for a day without
 * holding any compute. The bot's own tool approvals surface on this session
 * while it works.
 */
export default defineWorkflowTool({
  description:
    "Hand a job to its bot and let it work. Returns immediately with a receipt; the result arrives later as a task notification. Use this after assign_job, or to re-run a scheduled or failed job now.",
  inputSchema: z.object({
    jobId: z.string().describe("The job to run."),
  }),
  execution: "background",
  label: {
    start: ({ jobId }) => `Run ${jobId}`,
  },
  async *execute({ jobId }, ctx) {
    "use workflow";
    const workspaceId = operator(ctx).workspaceId;

    const claim = await claimForRun(workspaceId, jobId);
    if (!claim.ok) return { jobId, ran: false as const, reason: claim.reason };

    yield { phase: "working", bot: claim.botName, title: claim.title };

    let result: JobResult;
    try {
      const raw = await ctx.agent("teammate", {
        message: claim.brief,
        outputSchema: JOB_RESULT_SCHEMA,
      });
      result = JobResultZ.parse(raw);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await markFailed(workspaceId, jobId, message);
      return { jobId, ran: true as const, status: "failed" as const, error: message };
    }

    if (claim.requiresSignoff || result.needsHuman) {
      yield { phase: "awaiting sign-off", bot: claim.botName, title: claim.title };

      const pending = ctx.ask({
        prompt: [
          `${claim.botName} finished "${claim.title}" and needs your sign-off.`,
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

      // `sleep` is a durable timer, not a setTimeout: nothing is held open while
      // the request sits on the operator's channel.
      const deadline = sleep(SIGNOFF_TIMEOUT).then(() => null);
      const answer = await Promise.race([pending, deadline]);

      if (answer === null) {
        await markBlocked(workspaceId, jobId, "Sign-off timed out after 24h.", result);
        return { jobId, ran: true as const, status: "blocked" as const, result };
      }
      if (answer.optionId !== "approve") {
        const note = answer.text ?? "Sent back for revision.";
        await markBlocked(workspaceId, jobId, note, result);
        return { jobId, ran: true as const, status: "blocked" as const, note, result };
      }
    }

    const closed = await markDone(workspaceId, jobId, result);
    return {
      jobId,
      ran: true as const,
      status: closed.repeats ? ("scheduled" as const) : ("done" as const),
      nextRunAt: closed.nextRunAt,
      result,
    };
  },
});

type Claim =
  | { ok: false; reason: string }
  | { ok: true; brief: string; botName: string; title: string; requiresSignoff: boolean };

/**
 * Takes the lease and writes the "started" event.
 *
 * A step, not body code: it touches the clock, generates an id, and writes to
 * storage. Replay reuses the recorded result instead of claiming twice.
 */
async function claimForRun(workspaceId: string, jobId: string): Promise<Claim> {
  "use step";
  const job = await getJob(workspaceId, jobId);
  if (job === null) return { ok: false, reason: `No job ${jobId} in this workspace.` };
  if (job.status === "cancelled") return { ok: false, reason: "That job was cancelled." };
  if (job.status === "done" && job.everyMinutes === null) {
    return { ok: false, reason: "That job is already finished." };
  }

  const bot = await getBot(workspaceId, job.botId);
  if (bot === null) return { ok: false, reason: "That job's bot is no longer on the roster." };
  if (bot.status === "paused") return { ok: false, reason: `${bot.name} is paused.` };

  const claimed = await claimJob(workspaceId, jobId, {
    token: newId("lease"),
    forMs: LEASE_MS,
    status: "running",
    kind: "run",
    countAttempt: true,
  });
  if (claimed === null) {
    return { ok: false, reason: "Another run already holds this job." };
  }

  await record({
    workspaceId,
    kind: "job.started",
    botId: bot.id,
    jobId,
    text: `${bot.name} started "${claimed.title}" (attempt ${claimed.attempts}).`,
  });

  return {
    ok: true,
    brief: renderBrief(bot, claimed),
    botName: bot.name,
    title: claimed.title,
    requiresSignoff: claimed.requiresSignoff,
  };
}

async function markDone(
  workspaceId: string,
  jobId: string,
  result: JobResult,
): Promise<{ repeats: boolean; nextRunAt: string | null }> {
  "use step";
  const job = await completeJob(workspaceId, jobId, result);
  const repeats = job?.status === "scheduled";
  return { repeats, nextRunAt: repeats ? (job?.runAt ?? null) : null };
}

async function markFailed(workspaceId: string, jobId: string, error: string): Promise<void> {
  "use step";
  await failJob(workspaceId, jobId, error);
}

async function markBlocked(
  workspaceId: string,
  jobId: string,
  note: string,
  result: JobResult,
): Promise<void> {
  "use step";
  await patchJob(workspaceId, jobId, (job) => ({ ...job, result }));
  await blockJob(workspaceId, jobId, note);
}
