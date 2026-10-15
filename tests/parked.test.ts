import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** S2: the live screen connection is kept between computer views, for a minute. */

const entry = (access: "view" | "control") => {
  const client = { disconnect: vi.fn() };
  return { client: client as never, host: { remove: vi.fn() } as never, access, onDrop: null, onClipboard: null, disconnect: client.disconnect };
};

describe("parked screen connection", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.stubGlobal("window", globalThis);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("is adopted once by the next view, and never a view-only one for control", async () => {
    const { adopt, park } = await import("../src/console/computer/parked");
    const view = entry("view");
    park(view);
    expect(adopt("control")).toBeNull();
    expect(adopt("view")).toBe(view);
    expect(adopt("view")).toBeNull();
    expect(view.disconnect).not.toHaveBeenCalled();
  });

  it("is dropped after a minute nobody adopted it, or when another replaces it", async () => {
    const { adopt, park } = await import("../src/console/computer/parked");
    const first = entry("control");
    const second = entry("view");
    park(first);
    park(second);
    expect(first.disconnect).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(60_001);
    expect(second.disconnect).toHaveBeenCalledOnce();
    expect(adopt("view")).toBeNull();
  });

  it("forgets a parked connection that dropped on its own", async () => {
    const { adopt, park } = await import("../src/console/computer/parked");
    const view = entry("view");
    park(view);
    (view as { onDrop: (() => void) | null }).onDrop?.();
    expect(adopt("view")).toBeNull();
  });
});
