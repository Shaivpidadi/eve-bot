import { describe, expect, it } from "vitest";

import { buildTimeline, qaFixtureBots } from "../src/console/room-store";
import type { ActivityEvent } from "../agent/lib/types";

/** HQ's thread does not show the QA suite's fixture Bots coming and going. */
const event = (over: Partial<ActivityEvent>): ActivityEvent => ({ id: Math.random().toString(36), workspaceId: "default", at: "2026-09-23T15:47:00.000Z", kind: "bot.hired", text: "", botId: null, jobId: null, ...over }) as ActivityEvent;

describe("QA fixture Bots", () => {
  const activity = [
    event({ kind: "bot.hired", botId: "bot_qa", text: "🤖 QA v4cub joined the team as QA fixture." }),
    event({ kind: "bot.updated", botId: "bot_qa", text: "QA v4cub's profile was updated." }),
    event({ kind: "bot.retired", botId: "bot_qa", text: "QA v4cub was removed by operator. 0 open job(s) cancelled." }),
    event({ kind: "bot.hired", botId: "bot_ava", text: "🦊 Ava joined the team as Sales follow-up." }),
  ];

  it("are recognised by their hire line", () => {
    expect([...qaFixtureBots(activity)]).toEqual(["bot_qa"]);
  });

  it("leave no lines in HQ's thread, while real hires stay", () => {
    const hq = { id: "hq", kind: "hq", clearedAt: null } as never;
    const timeline = buildTimeline(hq, [], activity);
    const texts = JSON.stringify(timeline);
    expect(texts).not.toContain("QA v4cub");
    expect(texts).toContain("Ava joined the team");
  });
});
