import { describe, expect, it } from "vitest";

import { nextStop, nextWake, runStopToken, wokeByStop } from "../agent/lib/run-stop";

/**
 * The stop signal's pure half (lib/run-stop.ts): which hook a run listens on,
 * and what wakes a run that waits on its bot. `run_job` races exactly these
 * with Workflow's `sleep` and hooks; plain promises stand in for them here.
 */

const never = new Promise<never>(() => undefined);

describe("runStopToken", () => {
  it("names one run's lease, and no other", () => {
    expect(runStopToken("lease_A")).toBe("bot-run-stop:lease_A");
    expect(runStopToken("lease_A")).not.toBe(runStopToken("lease_B"));
    // A wait token and a claim token never collide: both are fresh ids.
    expect(runStopToken("wait_1")).not.toBe(runStopToken("lease_1"));
  });
});

describe("nextWake", () => {
  it("returns what the bot settled with when it finishes first", async () => {
    expect(await nextWake(Promise.resolve({ ok: true }), never, never)).toEqual({ kind: "settled", settled: { ok: true } });
  });

  it("wakes on a stop while the bot is still working", async () => {
    let stop!: () => void;
    const stopped = new Promise<void>((resolve) => {
      stop = resolve;
    });
    const wake = nextWake(never, stopped, never);
    stop();
    expect(await wake).toEqual({ kind: "stop" });
  });

  it("wakes for the heartbeat when nothing else happened", async () => {
    expect(await nextWake(never, never, Promise.resolve())).toEqual({ kind: "beat" });
  });

  it("lets a bot that already settled win over a stop that arrived with it", async () => {
    expect(await nextWake(Promise.resolve("done"), Promise.resolve(), never)).toEqual({ kind: "settled", settled: "done" });
  });

  it("can be raced again on the same pending stop after a heartbeat", async () => {
    let stop!: () => void;
    const stopped = new Promise<void>((resolve) => {
      stop = resolve;
    });
    expect(await nextWake(never, stopped, Promise.resolve())).toEqual({ kind: "beat" });
    const again = nextWake(never, stopped, never);
    stop();
    expect(await again).toEqual({ kind: "stop" });
  });
});

describe("wokeByStop", () => {
  it("is false when the wait ran out and true when a stop cut it short", async () => {
    expect(await wokeByStop(Promise.resolve(), never)).toBe(false);
    expect(await wokeByStop(never, Promise.resolve())).toBe(true);
  });
});

describe("nextStop", () => {
  it("fires on the hook's next payload", async () => {
    expect(await nextStop(Promise.resolve({ reason: "cancelled" }))).toBeUndefined();
  });

  it("never fires, rather than failing the run, when the hook cannot listen", async () => {
    const outcome = await Promise.race([nextStop(Promise.reject(new Error("HookConflictError"))).then(() => "fired"), Promise.resolve("still waiting")]);
    expect(outcome).toBe("still waiting");
  });
});
