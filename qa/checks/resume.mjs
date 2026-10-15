import { expect } from "../harness.mjs";
import { feed, waitFor, waitForJobEvent } from "../lib/wait.mjs";

/**
 * A crash mid-job must not start the job over. With BOT_QA=1 the deployment
 * can crash a job's run (`/qa/jobs/:id/crash`); the next run is briefed with
 * the journal and must carry on from it: the file the first run wrote is
 * written once, and the job closes once. Needs a real job (QA_JOBS=1).
 */
const job = async (call, jobId) => (await call(`/bot/v1/jobs/${encodeURIComponent(jobId)}`)).body?.job ?? null;

function resumeCheck({ viaTick }) {
  return {
    name: `resume: a crashed run is continued from its journal${viaTick ? " (picked up by the sweep)" : " (re-run by HQ)"}`,
    run: async ({ call, withJobs }) => {
      if (!withJobs) return { skipped: "needs QA_JOBS=1" };
      const after = new Date().toISOString();
      const room = `qa-${Date.now().toString(36)}`;
      const file = `/workspace/bots/qa-${room}.txt`;
      const sent = await call(`/bot/v1/rooms/${room}/messages`, {
        method: "POST",
        body: {
          message: [
            `Assign a job to the generalist titled exactly "QA resume ${room}" and run it now. The job, in order, logging progress after each step:`,
            `1. Write the file ${file} containing the single line "first".`,
            `2. Run the shell command "sleep 120".`,
            `3. Append the line "second" to ${file}.`,
            "Then finish. Do not use the browser.",
          ].join("\n"),
        },
        timeoutMs: 60_000,
      });
      expect(sent.status, (status) => status < 400, "sending a message to HQ", { body: sent.body });

      const assigned = await waitFor(async () => (await feed(call, after)).find((entry) => entry.kind === "job.assigned" && entry.text.includes(room)), {
        until: (entry) => entry !== undefined,
        what: "the job to be assigned",
      });
      const jobId = assigned.jobId;

      // Crash once step 1 is in the journal, while the sleep runs. A Bot may write
      // the file with the shell rather than write_file, so its own note is the signal.
      const wroteFirst = (line) => (line.kind === "file" && line.data?.path === file) || (line.kind === "progress" && /first/i.test(line.text) && /(wrote|written|creat)/i.test(line.text));
      const before = await waitFor(() => job(call, jobId), {
        until: (record) => (record?.journal ?? []).some(wroteFirst),
        what: "the first run to write its file",
        timeoutMs: 240_000,
      });
      const crashed = await call(`/bot/v1/qa/jobs/${encodeURIComponent(jobId)}/crash`, { method: "POST" });
      if (crashed.status === 404) return { skipped: "the deployment has no BOT_QA=1" };
      expect(crashed.status, 200, "crashing the run", { body: crashed.body });

      if (viaTick) {
        const swept = await waitFor(() => call("/bot/v1/jobs/sweep", { method: "POST", timeoutMs: 60_000 }), {
          until: (response) => response.body?.swept === true && response.body.dispatched >= 1,
          what: "a sweep to dispatch the crashed job",
          timeoutMs: 150_000,
          everyMs: 20_000,
        });
        expect(swept.status, 200, "sweeping", { body: swept.body });
      } else {
        const asked = await call(`/bot/v1/rooms/${room}/messages`, { method: "POST", body: { message: `Job ${jobId} stopped. Run it again with run_job now.` }, timeoutMs: 60_000 });
        expect(asked.status, (status) => status < 400, "asking HQ to re-run", { body: asked.body });
      }

      const continued = await waitFor(async () => (await feed(call, after)).find((entry) => entry.jobId === jobId && entry.kind === "job.started" && entry.data?.resumedFrom > 0), {
        until: (entry) => entry !== undefined,
        what: "a second run that continues from the journal",
        timeoutMs: 240_000,
      });
      const end = await waitForJobEvent(call, after, jobId, ["job.done", "job.blocked", "job.failed", "job.cancelled"], { what: "the job to end", timeoutMs: 600_000 });
      expect(["job.done", "job.blocked"].includes(end.event.kind), true, "the job reached a working end state", { end: end.event });

      const final = await job(call, jobId);
      const closes = end.events.filter((entry) => entry.kind === "job.done");
      expect(closes.length <= 1, true, "the job closed once", { closes });
      expect(final?.resumedFrom, (n) => n >= (before.journal ?? []).length, "the second run started from the journal", { resumedFrom: final?.resumedFrom, continued });
      // The file itself says whether step 1 was redone: once means "first" then "second", and nothing else.
      const content = await call(`/bot/v1/computer/files/content?path=${encodeURIComponent(file)}`);
      const lines = typeof content.body === "string" ? content.body.trim().split("\n").map((line) => line.trim()) : null;
      expect(JSON.stringify(lines), JSON.stringify(["first", "second"]), "the file shows each step done once", { status: content.status, body: content.body, journal: final?.journal });
      return `resumed from step ${final?.resumedFrom}, ${(final?.journal ?? []).length} steps, file ${JSON.stringify(lines)}, ended ${end.event.kind}`;
    },
  };
}

export default [resumeCheck({ viaTick: false }), resumeCheck({ viaTick: true })];
