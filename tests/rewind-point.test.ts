import { beforeEach, describe, expect, it, vi } from "vitest";

/** A rewind point saved for a decision is taken before writes asked for in the same step. */
describe("holdPoint and afterPoint", () => {
  beforeEach(() => vi.resetModules());

  it("makes a write wait until the point is saved, and lets it through at once otherwise", async () => {
    const { afterPoint, holdPoint } = await import("../agent/subagents/teammate/lib/journal");
    const ctx = { session: { id: "run_1" } } as never;
    const order: string[] = [];
    await afterPoint(ctx);
    order.push("free write");
    const release = holdPoint(ctx);
    const write = afterPoint(ctx).then(() => order.push("write"));
    await new Promise((resolve) => setTimeout(resolve, 5));
    order.push("point saved");
    release();
    await write;
    expect(order).toEqual(["free write", "point saved", "write"]);
    // Another run is never held up by this one's point.
    const other = holdPoint(ctx);
    await afterPoint({ session: { id: "run_2" } } as never);
    other();
  });
});
