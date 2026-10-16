import { describe, expect, it } from "vitest";

import { buildTimeline } from "../src/console/room-store";
import type { ActivityEvent, Member } from "../src/console/types";

/** Each thread shows its own work: a hand-off reads as a conversation, and other threads' jobs stay out. */

const member = (over: Partial<Member>): Member =>
  ({ id: "hq", kind: "hq", room: "desk", name: "HQ", clearedAt: null, jobs: [], ...over }) as unknown as Member;
const hq = member({});
const wiki = member({ id: "bot_w", kind: "bot", room: "bot-bot_w", name: "Wiki" });
const event = (over: Partial<ActivityEvent>): ActivityEvent =>
  ({ id: `act_${Math.random()}`, workspaceId: "qa", at: "2026-10-14T10:00:00.000Z", botId: "bot_w", jobId: "job_1", data: {}, ...over }) as ActivityEvent;

const asked = event({ kind: "job.assigned", text: 'Wiki was assigned "Paris population".', data: { room: "desk", title: "Paris population" } });
const step = event({ kind: "job.progress", at: "2026-10-14T10:00:30.000Z", text: "Opened the page" });
const done = event({ kind: "job.done", at: "2026-10-14T10:01:00.000Z", text: 'Finished "Paris population" · $0.05: About 2.1 million.', data: { room: "desk", title: "Paris population", summary: "About 2.1 million." } });

describe("buildTimeline", () => {
  it("shows a Bot's work asked elsewhere as who asked, then its answer, without the steps", () => {
    const items = buildTimeline(wiki, [], [asked, step, done], [hq, wiki]);
    expect(items.map((item) => item.kind)).toEqual(["peer", "bot"]);
    expect(items[0]).toMatchObject({ kind: "peer", from: "HQ", text: "Paris population" });
    expect(items[1]).toMatchObject({ kind: "bot", text: "About 2.1 million." });
  });

  it("shows the job's result itself in the Bot's thread when the job kept one", () => {
    const withResult = { ...done, data: { ...done.data, deliverable: "Rome: **2.75 million** (2025)." } };
    expect(buildTimeline(wiki, [], [asked, withResult], [hq, wiki])[1]).toMatchObject({ kind: "bot", text: "Rome: **2.75 million** (2025)." });
  });

  it("keeps the steps for work asked in the Bot's own thread", () => {
    const here = (e: ActivityEvent) => ({ ...e, data: { ...e.data, room: "bot-bot_w" } });
    const items = buildTimeline(wiki, [], [here(asked), step, here(done)], [hq, wiki]);
    expect(items.map((item) => item.kind)).toEqual(["steps"]);
  });

  it("keeps another thread's job out of HQ's desk", () => {
    const elsewhere = { ...done, data: { ...done.data, room: "bot-bot_x" } };
    expect(buildTimeline(hq, [], [elsewhere], [hq, wiki])).toEqual([]);
  });

  it("shows a desk job's close on the desk only when HQ never relayed it", () => {
    expect(buildTimeline(hq, [], [done], [hq, wiki]).map((item) => item.kind)).toEqual(["notice"]);
    const relay = { kind: "notice" as const, key: "n", at: "2026-10-14T10:20:00.000Z", icon: "check" as const, label: "Work came back", jobId: "job_1" };
    expect(buildTimeline(hq, [relay], [done], [hq, wiki]).filter((item) => item.kind === "notice" && item.label !== "Work came back")).toEqual([]);
  });
});

describe("a failed turn", () => {
  it("shows once in its own thread: from the stream, not again from the feed", () => {
    const failed = event({ kind: "job.failed", botId: "hq", jobId: null, text: "A turn failed (MODEL_CALL_FAILED): No ZDR providers", data: { room: "desk", turn: true } });
    expect(buildTimeline(hq, [], [failed], [hq])).toEqual([]);
  });
});
