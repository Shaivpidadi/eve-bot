import { defineSchedule } from "eve/schedules";

import ops from "../channels/ops";
import { newId } from "../lib/ids";
import { claimJob, dueJobs, releaseJob } from "../lib/jobs";

const DISPATCH_LEASE_MS = 5 * 60_000;
const BATCH = Number(process.env.BOT_TICK_BATCH ?? 10);

/**
 * The heartbeat that makes the team always-on.
 *
 * Once a minute this looks for work that is due — scheduled jobs whose time has
 * come, repeating jobs on their next cycle, and runs whose lease lapsed because
 * a deploy or a crash interrupted them — claims each one, and wakes HQ in the
 * job's room to run it.
 *
 * The claim is a compare-and-set in durable storage, so two overlapping ticks
 * (or two regions) cannot dispatch the same job twice. Delivery is still
 * at-least-once: `run_job` re-checks the job before a bot touches anything.
 */
export default defineSchedule({
  cron: "* * * * *",
  run({ to, waitUntil, appAuth }) {
    waitUntil(
      (async () => {
        const jobs = await dueJobs(BATCH);

        await Promise.all(
          jobs.map(async (job) => {
            const claimed = await claimJob(job.workspaceId, job.id, {
              token: newId("dispatch"),
              forMs: DISPATCH_LEASE_MS,
              status: "dispatched",
              kind: "dispatch",
            });
            if (claimed === null) return;

            try {
              await to(ops, { room: job.room }).send(
                [
                  `Job ${job.id} is due: "${job.title}".`,
                  "Run it now with run_job, then report the outcome in one short message.",
                ].join(" "),
                {
                  auth: {
                    ...appAuth,
                    attributes: { workspaceId: job.workspaceId, room: job.room },
                  },
                },
              );
            } catch {
              // Could not hand it off — put it back rather than leaving it leased.
              await releaseJob(job.workspaceId, job.id);
            }
          }),
        );
      })(),
    );
  },
});
