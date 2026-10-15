import { beforeEach, describe, expect, it, vi } from "vitest";

import { foldUntil } from "../agent/lib/branch";
import { withBranches, type TimelineItem } from "../src/console/room-store";

/** Taking a thread back to one of its messages (D5.3). */

const said = (id: string, type: "message.received" | "message.completed", message: string, at: string) => ({
  type,
  meta: { id, at },
  data: { message, sequence: 0, turnId: `turn_${id}`, ...(type === "message.completed" ? { finishReason: "stop", stepIndex: 0 } : { parts: [{ type: "text", text: message }] }) },
});
const thread: Record<string, unknown[]> = {
  s1: [said("evt_a", "message.received", "I moved to Austin.", "2026-10-15T10:00:00.000Z"), said("evt_b", "message.completed", "Noted.", "2026-10-15T10:00:02.000Z")],
  s2: [said("evt_c", "message.received", "Lunch downtown?", "2026-10-15T10:05:00.000Z"), said("evt_d", "message.completed", "Try Phoebe's.", "2026-10-15T10:05:03.000Z")],
};
async function* read(sessionId: string): AsyncIterable<unknown> {
  yield* thread[sessionId] ?? [];
}

describe("foldUntil", () => {
  it("keeps the conversation up to and including the chosen message, across sessions", async () => {
    const point = await foldUntil(["s1", "s2"], read, "evt_c");
    expect(point).toMatchObject({ eventAt: "2026-10-15T10:05:00.000Z", text: "Lunch downtown?" });
    expect(point?.messages.map((message) => message.text)).toEqual(["I moved to Austin.", "Noted.", "Lunch downtown?"]);
  });

  it("stops early: nothing after the point is read", async () => {
    const point = await foldUntil(["s1", "s2"], read, "evt_a");
    expect(point?.messages).toEqual([{ role: "user", text: "I moved to Austin." }]);
  });

  it("finds nothing for an id that is not a message in the thread", async () => {
    expect(await foldUntil(["s1", "s2"], read, "evt_zzz")).toBeNull();
  });
});

const item = (key: string, kind: "you" | "bot", at: string, text = key): TimelineItem => ({ kind, key, at, text });
const branch = { eventId: "evt_a", eventAt: "2026-10-15T10:00:00.000Z", at: "2026-10-15T10:10:00.000Z", by: "Ava", jobs: [] as { id: string; title: string; status: string }[] };

describe("withBranches", () => {
  it("fades what came after the point and puts a divider where the new branch starts", () => {
    const items = [item("evt_a", "bot", "2026-10-15T10:00:00.000Z", "Try **Phoebe's Downtown**, an American eatery on West 11th that is open until three."), item("evt_b", "you", "2026-10-15T10:00:02.000Z"), item("evt_e", "you", "2026-10-15T10:11:00.000Z")];
    const out = withBranches(items, [{ ...branch, jobs: [{ id: "job_1", title: "Book a table", status: "running" }, { id: "job_2", title: "Old one", status: "done" }] }]);
    expect(out.map((entry) => [entry.key, entry.old === true])).toEqual([
      ["evt_a", false],
      ["evt_b", true],
      ["branch:2026-10-15T10:10:00.000Z", false],
      ["evt_e", false],
    ]);
    expect(out[2]).toMatchObject({ kind: "notice", icon: "branch", label: "Went back to \u201cTry Phoebe's Downtown, an American eatery on West 11th\u2026\u201d", detail: "1 message above stay on the old branch · still going from it: Book a table" });
  });

  it("leaves a thread alone when the point is not on screen", () => {
    const items = [item("evt_x", "you", "2026-10-15T10:00:00.000Z")];
    expect(withBranches(items, [branch])).toEqual(items);
  });
});

describe("the branch seed", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("BOT_STORE", "memory");
  });

  it("goes to the first session that asks, again to that one, and to no other", async () => {
    const rooms = await import("../agent/lib/roomstate");
    await rooms.noteBranch("ws", "desk", branch, [{ role: "user", text: "I moved to Austin." }]);
    expect(await rooms.takeSeed("ws", "desk", "s3")).toEqual([{ role: "user", text: "I moved to Austin." }]);
    expect(await rooms.takeSeed("ws", "desk", "s3")).toHaveLength(1);
    expect(await rooms.takeSeed("ws", "desk", "s4")).toBeNull();
    expect((await rooms.getRoomState("ws", "desk"))?.branches).toHaveLength(1);
  });
});
