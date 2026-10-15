import { beforeEach, describe, expect, it, vi } from "vitest";

import { isWedged, WEDGED_AFTER_MS } from "../agent/lib/roomstate";

const t0 = Date.parse("2026-09-22T09:00:00.000Z");
const at = (offsetMs: number) => new Date(t0 + offsetMs).toISOString();

/** When a thread counts as wedged: a message went in, no turn followed, and long enough has passed. */
describe("isWedged", () => {
  it("is calm while nothing was sent, or a turn followed the last message", () => {
    expect(isWedged(null, t0)).toBe(false);
    expect(isWedged({ sentAt: null, turnAt: null }, t0)).toBe(false);
    expect(isWedged({ sentAt: at(0), turnAt: at(500) }, t0 + WEDGED_AFTER_MS * 2)).toBe(false);
  });

  it("gives a fresh message its grace, then calls it", () => {
    expect(isWedged({ sentAt: at(0), turnAt: null }, t0 + WEDGED_AFTER_MS - 1)).toBe(false);
    expect(isWedged({ sentAt: at(0), turnAt: null }, t0 + WEDGED_AFTER_MS)).toBe(true);
    // A turn from before this message does not count as picking it up.
    expect(isWedged({ sentAt: at(60_000), turnAt: at(0) }, t0 + 60_000 + WEDGED_AFTER_MS)).toBe(true);
    expect(isWedged({ sentAt: "not a date", turnAt: null }, t0 + WEDGED_AFTER_MS)).toBe(false);
  });
});

describe("isWedged with a turn open", () => {
  it("never calls a thread wedged while a turn is running: since eve 0.79 a job's run keeps it open", () => {
    expect(isWedged({ sentAt: at(0), turnAt: null, active: true }, t0 + WEDGED_AFTER_MS * 3)).toBe(false);
    expect(isWedged({ sentAt: at(0), turnAt: null, active: false }, t0 + WEDGED_AFTER_MS * 3)).toBe(true);
  });
});

describe("a thread's earlier sessions", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("BOT_STORE", "memory");
  });

  it("keeps the sessions a thread moved off, oldest first, and clears them when it starts over", async () => {
    const rooms = await import("../agent/lib/roomstate");
    await rooms.noteSession("ws", "desk", "s1");
    await rooms.noteSession("ws", "desk", "s1");
    await rooms.noteSession("ws", "desk", "s2");
    expect(await rooms.getRoomState("ws", "desk")).toMatchObject({ sessionId: "s2", sessions: ["s1"] });
    // The watchdog moving it on keeps the one it left.
    await rooms.restartRoom("ws", "desk");
    await rooms.noteSession("ws", "desk", "s3");
    expect(await rooms.getRoomState("ws", "desk")).toMatchObject({ sessionId: "s3", sessions: ["s1", "s2"] });
    await rooms.resetRoom("ws", "desk");
    expect(await rooms.getRoomState("ws", "desk")).toMatchObject({ sessionId: null, sessions: [] });
  });
});
