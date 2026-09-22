import { describe, expect, it } from "vitest";

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
