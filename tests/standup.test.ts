import { describe, expect, it, vi } from "vitest";

import { HQ_ROOM, roomForBot } from "../agent/lib/rooms";
import { isBoardRoom, STANDUP_DEFAULT_CRON, standupCron, standupRoom } from "../agent/lib/standup";

describe("standup destination", () => {
  it("posts to HQ's desk by default, a room the board lists", () => {
    expect(standupRoom({})).toBe(HQ_ROOM);
    expect(isBoardRoom(standupRoom({}))).toBe(true);
  });

  it("honours an override that names a room the board lists", () => {
    expect(standupRoom({ BOT_STANDUP_ROOM: roomForBot("abc123") })).toBe("bot-abc123");
    expect(standupRoom({ BOT_STANDUP_ROOM: HQ_ROOM })).toBe(HQ_ROOM);
  });

  it("falls back to the desk when the override names a room nobody can open", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(standupRoom({ BOT_STANDUP_ROOM: "standup" })).toBe(HQ_ROOM);
    expect(standupRoom({ BOT_STANDUP_ROOM: "bot-" })).toBe(HQ_ROOM);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("uses a weekday UTC cron unless one is set", () => {
    expect(standupCron({})).toBe(STANDUP_DEFAULT_CRON);
    expect(standupCron({ BOT_STANDUP_CRON: " " })).toBe(STANDUP_DEFAULT_CRON);
    expect(standupCron({ BOT_STANDUP_CRON: "30 7 * * 1-5" })).toBe("30 7 * * 1-5");
  });
});
