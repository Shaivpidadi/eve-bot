import { expect } from "../harness.mjs";
import { feed, waitFor, waitForJobEvent } from "../lib/wait.mjs";

/**
 * "Rewind to here" must put a job's files back as they were at that step and
 * start it again from there. A job writes `a`, records a decision, writes `b`
 * and waits; the check rewinds to just after the decision and expects `a`
 * there and `b` gone at once, then the job to finish. Needs QA_JOBS=1.
 */
const job = async (call, jobId) => (await call(`/bot/v1/jobs/${encodeURIComponent(jobId)}`)).body?.job ?? null;
const content = async (call, path) => call(`/bot/v1/computer/files/content?path=${encodeURIComponent(path)}`);

export default [
  {
    name: "rewind: a job taken back to a step gets that step's files and runs again from there",
    run: async ({ call, withJobs }) => {
      if (!withJobs) return { skipped: "needs QA_JOBS=1" };
      const after = new Date().toISOString();
      const room = `qa-${Date.now().toString(36)}`;
      const roster = await call("/bot/v1/state");
      const generalist = roster.body?.members?.find((member) => member.kind === "bot" && member.status !== "retired");
      if (generalist === undefined) return { skipped: "no Bot on the roster" };
      const dir = `/workspace/bots/${generalist.name}/rewind-${room}`;
      const sent = await call(`/bot/v1/rooms/${room}/messages`, {
        method: "POST",
        body: {
          message: [
            `Assign a job to ${generalist.name} titled exactly "QA rewind ${room}" and run it now. In order:`,
            `1. Write the file ${dir}/a.txt containing "a", and log progress.`,
            `2. Log progress with kind "decision": "write b next".`,
            `3. Write the file ${dir}/b.txt containing "b", and log progress.`,
            `4. Run the shell command "sleep 90".`,
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

      const before = await waitFor(() => content(call, `${dir}/b.txt`), { until: (response) => response.status === 200, what: "b.txt to be written", timeoutMs: 300_000, everyMs: 4_000 });
      expect(before.status, 200, "b.txt exists before the rewind");
      const record = await job(call, jobId);
      const decision = (record?.journal ?? []).findIndex((line) => line.kind === "decision");
      expect(decision >= 0, true, "the journal has the decision", { journal: record?.journal });

      const rewound = await call(`/bot/v1/jobs/${encodeURIComponent(jobId)}/rewind`, { method: "POST", body: { index: decision + 1 }, timeoutMs: 120_000 });
      expect(rewound.status, 200, "rewinding", { body: rewound.body });
      expect(rewound.body?.files?.restoredFrom, (n) => typeof n === "number", "the files were restored from a saved point", { body: rewound.body });
      const a = await content(call, `${dir}/a.txt`);
      const b = await content(call, `${dir}/b.txt`);
      expect(a.status, 200, "a.txt is back (it existed at the decision)", { a: a.body });
      expect(b.status, 404, "b.txt is gone (written after the decision)", { b: b.body });

      const end = await waitForJobEvent(call, after, jobId, ["job.done", "job.blocked", "job.failed", "job.cancelled"], { what: "the job to end", timeoutMs: 600_000 });
      expect(["job.done", "job.blocked"].includes(end.event.kind), true, "the job reached a working end state after the rewind", { end: end.event });
      const final = await job(call, jobId);
      expect(final?.rewound?.index, decision + 1, "the job records the rewind", { rewound: final?.rewound });
      return `rewound to step ${decision + 1} (files from step ${rewound.body.files.restoredFrom}), ended ${end.event.kind}`;
    },
  },
];
