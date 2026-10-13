import { expect } from "../harness.mjs";
import { feed, waitFor, waitForJobEvent } from "../lib/wait.mjs";

/**
 * A rebuild mid-job must not lose the job. With BOT_QA=1 the deployment can
 * pretend it restarted with new code (`/qa/build/bump`): the running job's
 * lease then belongs to nobody, and a sweep re-dispatches it with a line in
 * the feed saying why. Needs a real job, so it runs only with QA_JOBS=1.
 */
export default [
  {
    name: "stranded: a job whose run was lost to a rebuild is picked up again by the sweep",
    run: async ({ call, withJobs }) => {
      if (!withJobs) return { skipped: "needs QA_JOBS=1" };
      const probe = await call("/bot/v1/qa/build/bump", { method: "POST" });
      if (probe.status === 404) return { skipped: "the deployment has no BOT_QA=1" };
      expect(probe.status, 200, "bumping the build", { body: probe.body });

      const after = new Date().toISOString();
      const room = `qa-${Date.now().toString(36)}`;
      const sent = await call(`/bot/v1/rooms/${room}/messages`, {
        method: "POST",
        body: {
          message: `Assign a job to the generalist titled exactly "QA stranded ${room}": in your workspace run the shell command "for i in 1 2 3 4 5 6; do sleep 20; echo tick $i; done", logging progress after it finishes, then finish. Do not use the browser. Run it now.`,
        },
        timeoutMs: 60_000,
      });
      expect(sent.status, (status) => status < 400, "sending a message to HQ", { body: sent.body });

      const assigned = await waitFor(async () => (await feed(call, after)).find((entry) => entry.kind === "job.assigned" && entry.text.includes(room)), {
        until: (entry) => entry !== undefined,
        what: "the job to be assigned",
      });
      const jobId = assigned.jobId;
      await waitForJobEvent(call, after, jobId, ["job.started"], { what: "the first run to start" });

      // New code arrives while the bot works.
      const bumped = await call("/bot/v1/qa/build/bump", { method: "POST" });
      expect(bumped.status, 200, "bumping the build again", { body: bumped.body });
      const swept = await call("/bot/v1/jobs/sweep", { method: "POST", timeoutMs: 60_000 });
      expect(swept.status, 200, "sweeping", { body: swept.body });
      expect(swept.body?.stranded, (n) => n >= 1, "the sweep found the stranded job", { body: swept.body });

      const { events } = await waitForJobEvent(call, after, jobId, ["job.stranded"], { what: "the feed to say the job was picked up again" });
      const starts = events.filter((entry) => entry.kind === "job.started");
      const second = await waitFor(async () => (await feed(call, after)).filter((entry) => entry.jobId === jobId && entry.kind === "job.started"), {
        until: (entries) => entries.length >= 2,
        what: "a second run to start",
        timeoutMs: 180_000,
      });
      expect(second.length >= 2, true, "the job started again", { starts, second });

      const end = await waitForJobEvent(call, after, jobId, ["job.done", "job.blocked", "job.failed", "job.cancelled"], { what: "the job to end", timeoutMs: 300_000 });
      expect(["job.done", "job.blocked"].includes(end.event.kind), true, "the job reached a working end state", { end: end.event });
      return `stranded, re-dispatched, ended ${end.event.kind}`;
    },
  },
];
