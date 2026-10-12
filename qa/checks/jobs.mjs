import { expect } from "../harness.mjs";

/**
 * The flows that cost model tokens, and the ones worth the money.
 *
 * A job is the product. These run only with QA_JOBS=1, because each one puts
 * a real request through a real model on the deployment under test.
 *
 * The console API does not list jobs; it reports them through the activity
 * feed, by id. HQ answers a message after the request returns, so each check
 * names its job after its own room and follows that job through the feed.
 */
const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ENDED = new Set(["job.done", "job.blocked", "job.failed", "job.cancelled"]);

/** The feed since `after`, oldest first. */
async function feed(call, after) {
  const state = await call(`/bot/v1/state?after=${encodeURIComponent(after)}`);
  return [...(state.body?.activity ?? [])].reverse();
}

/** Waits for HQ to assign the job whose title carries `tag`, and returns its id. */
async function assigned(call, after, tag, { timeoutMs = 120_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const event = (await feed(call, after)).find((entry) => entry.kind === "job.assigned" && entry.text.includes(tag));
    if (event !== undefined || Date.now() > deadline) return event?.jobId ?? null;
    await settle(3_000);
  }
}

/** Waits for a job to end, and returns everything the feed said about it. */
async function ended(call, after, jobId, { timeoutMs = 300_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const events = (await feed(call, after)).filter((entry) => entry.jobId === jobId);
    const end = events.find((entry) => ENDED.has(entry.kind));
    if (end !== undefined || Date.now() > deadline) return { events, end: end ?? null };
    await settle(3_000);
  }
}

export default [
  {
    name: "jobs: a job asked for in the thread is created and finishes",
    run: async ({ call }) => {
      const after = new Date().toISOString();
      const room = `qa-${Date.now().toString(36)}`;
      const sent = await call(`/bot/v1/rooms/${room}/messages`, {
        method: "POST",
        body: {
          message: `Assign a job to the generalist titled exactly "QA fixture ${room}": write the three-line file qa-fixture.txt in your workspace saying hello, then finish. Do not use the browser. Run it now.`,
        },
        timeoutMs: 60_000,
      });
      expect(sent.status, (status) => status < 400, "sending a message to HQ", { body: sent.body });

      const jobId = await assigned(call, after, room);
      expect(jobId !== null, true, "a job was created", { feed: await feed(call, after) });

      const { events, end } = await ended(call, after, jobId);
      expect(end !== null, true, "the job settled inside the timeout", { events });
      expect(["job.done", "job.blocked"].includes(end.kind), true, "the job reached a working end state", { end });
      // The point of phase 0: a close says how much to trust it.
      const recorded = events.find((entry) => entry.text.startsWith("Result recorded ("));
      expect(
        end.kind === "job.blocked" || recorded !== undefined,
        true,
        "the result says how it was closed",
        { events },
      );
      return `${end.kind}${recorded ? ` · ${recorded.text.slice("Result recorded (".length).split(")")[0]}` : ""}`;
    },
  },
  {
    name: "jobs: a cancelled job stays cancelled",
    run: async ({ call }) => {
      const after = new Date().toISOString();
      const room = `qa-cancel-${Date.now().toString(36)}`;
      await call(`/bot/v1/rooms/${room}/messages`, {
        method: "POST",
        body: {
          message: `Assign a job to the generalist titled exactly "QA count ${room}": count slowly to one hundred, one number per progress note. Run it now.`,
        },
        timeoutMs: 60_000,
      });
      const jobId = await assigned(call, after, room);
      expect(jobId !== null, true, "a job was created", { feed: await feed(call, after) });

      // Cancel mid-run: a cancel that only works before the Bot starts proves little.
      const deadline = Date.now() + 180_000;
      let working = [];
      while (working.length < 2 && Date.now() < deadline) {
        await settle(2_000);
        working = (await feed(call, after)).filter((entry) => entry.jobId === jobId && entry.kind === "job.progress");
      }
      expect(working.length >= 2, true, "the Bot got to work before the cancel", { working });

      const cancelled = await call(`/bot/v1/jobs/${encodeURIComponent(jobId)}`, { method: "DELETE" });
      expect(cancelled.status, (status) => status < 400, "cancelling the job", { body: cancelled.body });
      const cancelledAt = new Date().toISOString();

      // Long enough for a run that ignored the cancel to show itself.
      await settle(45_000);
      const events = (await feed(call, after)).filter((entry) => entry.jobId === jobId);
      expect(events.some((entry) => entry.kind === "job.cancelled"), true, "the feed records the cancel", { events });
      expect(
        events.some((entry) => entry.kind === "job.done" || entry.kind === "job.failed"),
        false,
        "the job never closes another way",
        { events },
      );
      // An in-flight step may land just after the cancel; nothing may start after that.
      const late = events.filter((entry) => entry.at > cancelledAt && entry.kind === "job.started");
      expect(late.length, 0, "no run starts after the cancel", { late });
      const progress = events.filter((entry) => entry.at > cancelledAt && entry.kind === "job.progress");
      expect(progress.length <= 1, true, "the run stops within one step", { progress });
      return `cancelled after ${working.length} step(s) · ${cancelled.body?.interruption ?? "?"} · ${progress.length} step(s) after`;
    },
  },
];
