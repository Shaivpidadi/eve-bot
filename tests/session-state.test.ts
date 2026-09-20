import { describe, expect, it } from "vitest";

import { sessionState } from "../agent/subagents/teammate/lib/session-state";

describe("sessionState", () => {
  it("keeps what it is given", () => {
    const state = sessionState<number>(3);
    state.set("a", 1);
    expect(state.get("a")).toBe(1);
    expect(state.has("a")).toBe(true);
    state.delete("a");
    expect(state.get("a")).toBeUndefined();
  });

  it("drops the oldest session rather than growing without end", () => {
    const state = sessionState<number>(2);
    state.set("first", 1);
    state.set("second", 2);
    state.set("third", 3);
    expect(state.has("first")).toBe(false);
    expect(state.get("second")).toBe(2);
    expect(state.get("third")).toBe(3);
  });

  it("does not evict when an existing session is written again", () => {
    const state = sessionState<number>(2);
    state.set("first", 1);
    state.set("second", 2);
    state.set("first", 10);
    expect(state.get("first")).toBe(10);
    expect(state.get("second")).toBe(2);
  });
});
