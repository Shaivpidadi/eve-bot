import { beforeEach, describe, expect, it, vi } from "vitest";

const TABLE_KEY = "computer/bot-computer/screens.json";

const handover = (jobId: string | null, botId = "bot_1") => ({
  reason: "Sign in to Gmail with the team's Google account.",
  url: "https://mail.google.com",
  at: "2026-09-16T17:40:55.249Z",
  room: "bot-bot_1",
  requestId: "aitxt-1",
  jobId,
  botId,
});

const screen = (n: number, workspaceId: string, extra: Record<string, unknown> = {}) => ({
  n,
  workspaceId,
  botId: "bot_1",
  allocatedAt: "2026-09-16T17:00:00.000Z",
  lastUsedAt: "2026-09-16T17:00:00.000Z",
  browser: { state: "on", at: "2026-09-16T17:00:00.000Z" },
  control: null,
  posterAt: null,
  handover: null,
  handoverNote: null,
  ...extra,
});

/** A Bot's request for a person to take over its browser, on the team's screen. */
describe("handovers on the team's screen", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("BOT_STORE", "memory");
    vi.stubEnv("BOT_COMPUTER_NAME", undefined);
  });

  it("is cleared when the job that raised it ends, and left alone for any other job", async () => {
    const { writeDoc, readDoc } = await import("../agent/lib/store/index");
    const { forgetJob } = await import("../agent/lib/computer/screens");
    await writeDoc(TABLE_KEY, {
      computer: "bot-computer",
      screens: [
        screen(1, "default", { handover: handover("job_login"), handoverNote: "Signed in." }),
        screen(2, "acme", { handover: handover("job_other", "bot_9") }),
      ],
    });

    await forgetJob("default", "job_unrelated");
    let table = (await readDoc<{ screens: Array<{ handover: unknown; handoverNote: unknown }> }>(TABLE_KEY))?.value;
    expect(table?.screens[0]?.handover).not.toBeNull();

    await forgetJob("default", "job_login");
    table = (await readDoc<{ screens: Array<{ handover: unknown; handoverNote: unknown }> }>(TABLE_KEY))?.value;
    expect(table?.screens[0]?.handover).toBeNull();
    expect(table?.screens[0]?.handoverNote).toBeNull();
    // Another workspace's screen is not this workspace's business.
    expect(table?.screens[1]?.handover).not.toBeNull();
  });

  it("belongs to the Bot that asked, by id or, for older records, by job", async () => {
    const { handoverBelongsTo } = await import("../agent/lib/computer/screens");
    expect(handoverBelongsTo(handover("job_1"), "bot_1")).toBe(true);
    expect(handoverBelongsTo(handover("job_1"), "bot_2")).toBe(false);
    const { botId: _dropped, ...older } = handover("job_1");
    expect(handoverBelongsTo(older, "bot_1", ["job_1"])).toBe(true);
    expect(handoverBelongsTo(older, "bot_1", ["job_2"])).toBe(false);
    expect(handoverBelongsTo(null, "bot_1")).toBe(false);
  });

  it("returns what the person said when the Bot resumes, and ends the handover", async () => {
    const { writeDoc, readDoc } = await import("../agent/lib/store/index");
    const { finishHandover } = await import("../agent/lib/computer/screens");
    await writeDoc(TABLE_KEY, {
      computer: "bot-computer",
      screens: [screen(1, "default", { handover: handover("job_login"), handoverNote: "Done, it asked for a code too." })],
    });
    expect(await finishHandover(1)).toBe("Done, it asked for a code too.");
    expect((await readDoc<{ screens: Array<{ handover: unknown }> }>(TABLE_KEY))?.value.screens[0]?.handover).toBeNull();
    expect(await finishHandover(1)).toBeNull();
  });
});
