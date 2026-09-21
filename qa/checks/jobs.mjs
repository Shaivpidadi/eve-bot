import { expect } from "../harness.mjs";

/**
 * The flows that cost model tokens, and the ones worth the money.
 *
 * A job is the product. These run only with QA_JOBS=1, because each one puts
 * a real request through a real model on the deployment under test.
 */
const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits for the room to come back to rest, then returns everything it said. */
async function conversation(call, room, { timeoutMs = 180_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await call("/bot/v1/state");
    const jobs = state.body?.jobs ?? [];
    const busy = jobs.some((job) => ["queued", "dispatched", "running"].includes(job.status));
    if (!busy || Date.now() > deadline) return { state: state.body, timedOut: Date.now() > deadline };
    await settle(3_000);
  }
}

export default [
  {
    name: "jobs: a job asked for in the thread is created and finishes",
    run: async ({ call }) => {
      const room = `qa-${Date.now().toString(36)}`;
      const sent = await call(`/bot/v1/rooms/${room}/messages`, {
        method: "POST",
        body: { text: "Assign a job to the generalist: write the three-line file qa-fixture.txt in your workspace saying hello, then finish. Do not use the browser." },
        timeoutMs: 60_000,
      });
      expect(sent.status, (status) => status < 400, "sending a message to HQ", { body: sent.body });

      const { state, timedOut } = await conversation(call, room);
      expect(timedOut, false, "the job settled inside the timeout", { jobs: state?.jobs });

      const job = (state?.jobs ?? []).find((entry) => (entry.room ?? "") === room) ?? (state?.jobs ?? [])[0];
      expect(job !== undefined, true, "a job was created", { jobs: state?.jobs });
      expect(["done", "blocked"].includes(job.status), true, "the job reached an end state", { job });
      // The point of phase 0: a close says how much to trust it.
      expect(
        job.result === null || ["verified", "recorded", "recovered", undefined].includes(job.result?.completion),
        true,
        "the result says how it was closed",
        { result: job.result },
      );
      return `${job.status}${job.result?.completion ? ` · ${job.result.completion}` : ""}`;
    },
  },
  {
    name: "jobs: a cancelled job stays cancelled",
    run: async ({ call }) => {
      const room = `qa-cancel-${Date.now().toString(36)}`;
      await call(`/bot/v1/rooms/${room}/messages`, {
        method: "POST",
        body: { text: "Assign a job to the generalist: count slowly to one hundred in your progress notes." },
        timeoutMs: 60_000,
      });
      const cancelled = await call(`/bot/v1/rooms/${room}/cancel`, { method: "POST" });
      expect(cancelled.status, (status) => status < 400, "cancelling the room's work", { body: cancelled.body });

      await settle(10_000);
      const state = await call("/bot/v1/state");
      const running = (state.body?.jobs ?? []).filter(
        (job) => (job.room ?? "") === room && ["queued", "dispatched", "running"].includes(job.status),
      );
      expect(running.length, 0, "nothing from that room is still running", { running });
    },
  },
];
