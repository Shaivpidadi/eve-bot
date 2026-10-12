import { describe, expect, it } from "vitest";

import { nextWake } from "../agent/lib/run-stop";

/** How a `run_job` run waits on its bot (see run-stop.ts). */

const never = new Promise<never>(() => {});

describe("nextWake", () => {
  it("returns what the bot settled with when it finishes first", async () => {
    expect(await nextWake(Promise.resolve("done"), never)).toEqual({ kind: "settled", settled: "done" });
  });

  it("wakes for the heartbeat when the bot is still working", async () => {
    expect(await nextWake(never, Promise.resolve())).toEqual({ kind: "beat" });
  });

  it("lets a bot that already settled win over a heartbeat due at the same time", async () => {
    expect(await nextWake(Promise.resolve("done"), Promise.resolve())).toEqual({ kind: "settled", settled: "done" });
  });

  it("can be raced again on the same working bot after a heartbeat", async () => {
    let finish!: (value: string) => void;
    const working = new Promise<string>((resolve) => {
      finish = resolve;
    });
    expect(await nextWake(working, Promise.resolve())).toEqual({ kind: "beat" });
    finish("later");
    expect(await nextWake(working, never)).toEqual({ kind: "settled", settled: "later" });
  });
});
