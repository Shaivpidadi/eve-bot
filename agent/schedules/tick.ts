import { defineSchedule } from "eve/schedules";

import ops from "../channels/ops";
import { getBot } from "../lib/bots";
import { reapIdleScreens } from "../lib/computer/reaper";
import { newId } from "../lib/ids";
import { claimJob, dueJobs, failJob, releaseJob } from "../lib/jobs";
import { roomAttributes } from "../lib/rooms";
import type { Bot, Job } from "../lib/types";

const DISPATCH_LEASE_MS = 5 * 60_000;
const BATCH = Number(process.env.BOT_TICK_BATCH ?? 10);

/**
 * The watchdog that keeps the team always-on.
 *
 * Runs keep their own time: `run_job` sleeps durably until a job is due. So
 * this is a safety net, not the clock. It finds work that is due with nothing
 * waiting on it — a run cancelled while it slept, a repeat nobody re-armed, a
 * run whose lease lapsed because a deploy or crash interrupted it — claims each
 * job, and wakes HQ in the job's room to run it.
 *
 * Daily by default, because that is as often as Vercel Hobby runs cron jobs.
 * On Pro, `BOT_TICK_CRON="* * * * *"` picks up stragglers within a minute.
 *
 * The claim is a compare-and-set in durable storage, so two overlapping passes
 * (or two regions) cannot dispatch the same job twice. Delivery is still
 * at-least-once: `run_job` re-checks the job before a bot touches anything.
 */
export default defineSchedule({
  cron: process.env.BOT_TICK_CRON ?? "17 6 * * *",
  run({ to, waitUntil, appAuth }) {
    waitUntil(
      (async () => {
        const runnable = await pickRunnable(await dueJobs(Number.POSITIVE_INFINITY));

        await Promise.all(
          runnable.map(async (job) => {
            const token = newId("dispatch");
            const claimed = await claimJob(job.workspaceId, job.id, {
              token,
              forMs: DISPATCH_LEASE_MS,
              status: "dispatched",
              kind: "dispatch",
            });
            if (!claimed.ok) return;

            try {
              await to(ops, { workspaceId: job.workspaceId, room: job.room }).send(
                [
                  `Job ${job.id} is due: "${job.title}".`,
                  "Run it now with run_job, then report the outcome in one short message.",
                ].join(" "),
                {
                  auth: { ...appAuth, attributes: roomAttributes(job.workspaceId, job.room) },
                },
              );
            } catch {
              // Could not hand it off — put it back rather than leaving it leased.
              await releaseJob(job.workspaceId, job.id, { token });
            }
          }),
        );
      })(),
    );
    // Browsers nobody is using are stopped; they start again on the next use.
    waitUntil(reapIdleScreens().catch(() => 0));
  },
});

/**
 * Skips paused bots so their jobs wait quietly instead of being re-dispatched
 * every few minutes, and closes jobs whose bot has been retired.
 */
async function pickRunnable(due: readonly Job[]): Promise<Job[]> {
  const bots = new Map<string, Bot | null>();
  const picked: Job[] = [];
  for (const job of due) {
    if (picked.length >= BATCH) break;
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
