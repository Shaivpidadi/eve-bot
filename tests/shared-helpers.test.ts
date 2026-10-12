import { afterEach, describe, expect, it, vi } from "vitest";

import { within } from "../agent/lib/cancel";
import { spent } from "../agent/lib/jev";
import { reportedCost } from "../agent/lib/spend";

/**
 * Helpers shared instead of repeated: one reading of Gateway's price for the
 * ledger and the budget, and one bound on a call into eve.
 */
describe("Gateway's price, for the ledger and the budget", () => {
  const usage = { inputTokens: 10, outputTokens: 1 };

  it("reads a price sent as a number or a numeric string the same for both", () => {
    for (const cost of [0.0123, "0.0123"]) {
      expect(reportedCost({ gateway: { cost } })).toBe(0.0123);
      expect(spent(usage, { gateway: { cost } }, "m").costUsd).toBe(0.0123);
    }
  });

  it("keeps a reported zero a known zero", () => {
    expect(reportedCost({ gateway: { cost: 0 } })).toBe(0);
    expect(spent(usage, { gateway: { cost: "0" } }, "m").costUsd).toBe(0);
  });

  it("is unknown to the budget but 0 on the ledger when no usable price came back", () => {
    // NaN, Infinity, junk and absence are never a price: the budget counts the
    // call as unknown (null), and the ledger, which has no unknown, adds 0.
    for (const metadata of [undefined, null, {}, { gateway: {} }, { gateway: { cost: "n/a" } }, { gateway: { cost: Number.NaN } }, { gateway: { cost: Number.POSITIVE_INFINITY } }, { gateway: { cost: true } }]) {
      expect(reportedCost(metadata)).toBeNull();
      const ledger = spent(usage, metadata, "m").costUsd;
      expect(ledger).toBe(0);
      expect(Number.isNaN(ledger)).toBe(false);
    }
  });
});

describe("within", () => {
  afterEach(() => vi.useRealTimers());

  it("passes through what settles in time and clears its timer", async () => {
    vi.useFakeTimers();
    await expect(within(Promise.resolve("ok"), 1_000)).resolves.toBe("ok");
    await expect(within(Promise.reject(new Error("refused")), 1_000)).rejects.toThrow("refused");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects once the bound passes", async () => {
    vi.useFakeTimers();
    const late = within(new Promise(() => undefined), 50);
    const settled = expect(late).rejects.toThrow("timed out after 50ms");
    await vi.advanceTimersByTimeAsync(50);
    await settled;
  });
});
