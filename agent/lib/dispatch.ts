import { record } from "./activity";
import { getBot } from "./bots";
import { newId } from "./ids";
import { claimJob, dueJobs, failJob, leaseStranded, releaseJob } from "./jobs";
import type { Bot, Job } from "./types";

/**
 * One pass of the watchdog: find due jobs with nothing waiting on them, claim
 * each, and wake HQ in the job's room to run it. The daily tick runs it, and
 * so does a sweep on start or from the console, so a job stranded by a
 * restart is picked up without waiting for the clock.
 *
 * The claim is a compare-and-set in durable storage, so two overlapping
 * passes cannot dispatch the same job twice. Delivery is still at-least-once:
 * `run_job` re-checks the job before a bot touches anything.
 */
export const DISPATCH_LEASE_MS = 5 * 60_000;

export interface DispatchOutcome {
  readonly due: number;
  readonly dispatched: number;
  /** Jobs whose run was lost to a code change, re-dispatched here. */
  readonly stranded: number;
  readonly ms: number;
}

export async function dispatchDue(
  send: (job: Job, message: string) => Promise<void>,
  options: { readonly batch?: number } = {},
): Promise<DispatchOutcome> {
  const started = Date.now();
  const batch = options.batch ?? Number(process.env.BOT_TICK_BATCH ?? 10);
  const due = await dueJobs(Number.POSITIVE_INFINITY);
  const runnable = await pickRunnable(due, batch);
  let dispatched = 0;
  let stranded = 0;

  await Promise.all(
    runnable.map(async (job) => {
      const wasStranded = job.lease !== null && leaseStranded(job.lease);
      const token = newId("dispatch");
      const claimed = await claimJob(job.workspaceId, job.id, {
        token,
        forMs: DISPATCH_LEASE_MS,
        status: "dispatched",
        kind: "dispatch",
      });
      if (!claimed.ok) return;

      if (wasStranded) {
        stranded += 1;
        const bot = await getBot(job.workspaceId, job.botId);
        await record({
          workspaceId: job.workspaceId,
          kind: "job.stranded",
          botId: job.botId,
          jobId: job.id,
          text: `The server restarted with new code while ${bot?.name ?? "the bot"} was on "${job.title}"; it is picking the job up again.`,
          data: { from: job.lease?.build ?? null, to: claimed.job.lease?.build ?? null },
        }).catch(() => undefined);
      }

      try {
        await send(job, [`Job ${job.id} is due: "${job.title}".`, "Run it now with run_job, then report the outcome in one short message."].join(" "));
        dispatched += 1;
      } catch {
        // Could not hand it off — put it back rather than leaving it leased.
        await releaseJob(job.workspaceId, job.id, { token });
      }
    }),
  );
  return { due: due.length, dispatched, stranded, ms: Date.now() - started };
}

/**
 * Skips paused bots so their jobs wait quietly instead of being re-dispatched
 * every few minutes, and closes jobs whose bot has been retired.
 */
async function pickRunnable(due: readonly Job[], batch: number): Promise<Job[]> {
  const bots = new Map<string, Bot | null>();
  const picked: Job[] = [];
  for (const job of due) {
    if (picked.length >= batch) break;
    const cacheKey = `${job.workspaceId}/${job.botId}`;
    if (!bots.has(cacheKey)) bots.set(cacheKey, await getBot(job.workspaceId, job.botId));
    const bot = bots.get(cacheKey) ?? null;

    if (bot === null) {
      await failJob(job.workspaceId, job.id, "Its bot is no longer on the roster.");
    } else if (bot.status === "active") {
      picked.push(job);
    }
  }
  return picked;
}
