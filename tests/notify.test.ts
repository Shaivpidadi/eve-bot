import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What reaches a person's devices (agent/lib/notify.ts): a Bot that needs
 * them, at once; a job that ended, outside quiet hours; and nothing else.
 */

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv("BOT_STORE", "memory");
  vi.stubEnv("BOT_COMPUTER_KEY", "k".repeat(40));
});

const event = (kind: string, over: Record<string, unknown> = {}) => ({ kind, botId: "bot_a", jobId: "job_1", text: "Waiting on a human: Approve the refund?", data: {}, ...over }) as never;

describe("alertFor", () => {
  it("makes needs-you pushes urgent and links them to the Bot's thread", async () => {
    const { alertFor } = await import("../agent/lib/notify");
    expect(alertFor(event("input.requested"), "Atlas")).toEqual({
      kind: "needs-you",
      title: "Atlas needs you",
      body: "Approve the refund?",
      url: "/bot?thread=bot_a",
      tag: "ask-bot_a",
      urgent: true,
    });
    expect(alertFor(event("job.blocked", { text: 'Atlas finished "X" and is waiting for your sign-off.' }), "Atlas")).toMatchObject({ kind: "needs-you", urgent: true, tag: "job-job_1" });
    expect(alertFor(event("input.requested", { botId: null }), null)).toMatchObject({ title: "HQ needs you", url: "/bot?thread=hq" });
  });

  it("tells of a job that ended, and nothing of what the person did or saw happen", async () => {
    const { alertFor } = await import("../agent/lib/notify");
    expect(alertFor(event("job.done", { data: { title: "PM tools", summary: "Linear wins for 10 people." } }), "Atlas")).toMatchObject({
      kind: "done",
      title: 'Atlas finished "PM tools"',
      body: "Linear wins for 10 people.",
      urgent: false,
    });
    expect(alertFor(event("job.failed", { data: { title: "PM tools", error: "Out of budget" } }), "Atlas")).toMatchObject({ title: 'Atlas could not finish "PM tools"', body: "Out of budget" });
    expect(alertFor(event("job.failed", { data: { turn: true } }), "Atlas")).toBeNull();
    expect(alertFor(event("job.blocked", { data: { sentBack: true } }), "Atlas")).toBeNull();
    expect(alertFor(event("job.progress"), "Atlas")).toBeNull();
    expect(alertFor(event("memory.saved"), "Atlas")).toBeNull();
  });
});

describe("quietUntil", () => {
  it("holds the night (22:00 to 08:00 where the workspace is) until morning", async () => {
    const { quietUntil } = await import("../agent/lib/notify");
    // 23:30 in Berlin (UTC+2 in October) is quiet until 08:00 there, 06:00 UTC.
    expect(quietUntil(new Date("2026-10-19T21:30:00Z"), "Europe/Berlin")?.toISOString()).toBe("2026-10-20T06:00:00.000Z");
    expect(quietUntil(new Date("2026-10-20T10:00:00Z"), "Europe/Berlin")).toBeNull();
    // An unknown zone counts as UTC rather than failing.
    expect(quietUntil(new Date("2026-10-20T23:00:00Z"), "Not/AZone")?.toISOString()).toBe("2026-10-21T08:00:00.000Z");
  });
});

describe("recording an event", () => {
  it("pushes what needs a person to every device in the workspace, once", async () => {
    const sent: unknown[] = [];
    vi.doMock("web-push", async () => {
      const real = await vi.importActual<{ default: Record<string, unknown> }>("web-push");
      const fake = { ...real.default, sendNotification: async (_subscription: unknown, payload: string) => void sent.push(JSON.parse(payload)) };
      return { ...real, default: fake };
    });
    try {
      const { subscribe } = await import("../agent/lib/push");
      await subscribe({ workspaceId: "ws", person: "ann", subscription: { endpoint: "https://push.example/1", keys: { p256dh: "BNcR".padEnd(87, "A"), auth: "tBHI".padEnd(22, "A") } }, device: "iPhone" });
      const { record } = await import("../agent/lib/activity");
      await record({ workspaceId: "ws", kind: "input.requested", text: "Waiting on a human: Send the email?", botId: null });
      // The same ask recorded again moments later (a takeover is) is not sent twice.
      await record({ workspaceId: "ws", kind: "input.requested", text: "Waiting on a human: Send the email?", botId: null });
      await record({ workspaceId: "ws", kind: "job.progress", text: "Opened the page", botId: null });
      expect(sent).toEqual([{ title: "HQ needs you", body: "Send the email?", url: "/bot?thread=hq", tag: "ask-hq", urgent: true, away: true }]);
    } finally {
      vi.doUnmock("web-push");
    }
  });
});

const keys = { p256dh: "BNcR".padEnd(87, "A"), auth: "tBHI".padEnd(22, "A") };

/** web-push with its sender replaced, so what would go out is collected instead. */
function fakeSender(sent: unknown[]) {
  vi.doMock("web-push", async () => {
    const real = await vi.importActual<{ default: Record<string, unknown> }>("web-push");
    return { ...real, default: { ...real.default, sendNotification: async (_subscription: unknown, payload: string) => void sent.push(JSON.parse(payload)) } };
  });
}

describe("each person's choices", () => {
  it("decide what reaches whom, and hold the rest through their own quiet hours", async () => {
    vi.stubEnv("BOT_TIMEZONE", "UTC");
    const sent: { title: string }[] = [];
    fakeSender(sent);
    try {
      const { subscribe } = await import("../agent/lib/push");
      const { savePrefs } = await import("../agent/lib/push-prefs");
      const { deliver } = await import("../agent/lib/notify");
      await subscribe({ workspaceId: "ws", person: "ann", subscription: { endpoint: "https://push.example/ann", keys }, device: "iPhone" });
      await subscribe({ workspaceId: "ws", person: "bob", subscription: { endpoint: "https://push.example/bob", keys }, device: "Mac" });
      // Ann wants no news of jobs; Bob is in quiet hours all day long (from 0 to 23).
      await savePrefs("ws", "ann", { done: false, quietFrom: 0, quietTo: 0 });
      await savePrefs("ws", "bob", { quietFrom: 0, quietTo: 23 });
      const done = { kind: "done", title: "Atlas finished", body: "b", url: "/bot", tag: "job-1", urgent: false } as const;
      expect(await deliver("ws", done)).toBe(1);
      expect(sent).toHaveLength(0);
      // What needs them reaches both at once, quiet hours or not.
      await deliver("ws", { ...done, kind: "needs-you", title: "Atlas needs you", urgent: true });
      expect(sent.map((message) => message.title)).toEqual(["Atlas needs you", "Atlas needs you"]);
    } finally {
      vi.doUnmock("web-push");
    }
  });
});

describe("news from Bots", () => {
  it("is sent once per key, and at most three an hour", async () => {
    vi.stubEnv("BOT_TIMEZONE", "UTC");
    const sent: { title: string }[] = [];
    fakeSender(sent);
    try {
      const { subscribe } = await import("../agent/lib/push");
      const { savePrefs } = await import("../agent/lib/push-prefs");
      const { nudge } = await import("../agent/lib/notify");
      await subscribe({ workspaceId: "ws", person: "ann", subscription: { endpoint: "https://push.example/ann", keys }, device: "iPhone" });
      await savePrefs("ws", "ann", { quietFrom: 0, quietTo: 0 });
      const news = (key: string) => nudge({ workspaceId: "ws", botId: "bot_a", who: "Newsie", title: "HN top story changed", message: "Now: Gemini 4", key });
      expect(await news("hn:1")).toMatchObject({ sent: true, reached: 1 });
      expect(await news("hn:1")).toMatchObject({ sent: false, reason: expect.stringContaining("same news") });
      await news("hn:2");
      await news("hn:3");
      expect(await news("hn:4")).toMatchObject({ sent: false, reason: expect.stringContaining("this hour") });
      expect(sent.map((message) => message.title)).toEqual(Array(3).fill("Newsie: HN top story changed"));
    } finally {
      vi.doUnmock("web-push");
    }
  });
});

describe("the morning", () => {
  it("brings a night's held notifications as one, and costs nothing while none is due", async () => {
    const sent: { title: string; body: string }[] = [];
    const { subscribe, holdPush, flushPushQueue } = await import("../agent/lib/push");
    const send = vi.fn(async (_subscription: unknown, payload: string) => void sent.push(JSON.parse(payload)));
    await subscribe({ workspaceId: "ws", person: "ann", subscription: { endpoint: "https://push.example/ann", keys }, device: "iPhone" });
    const morning = new Date(Date.now() + 60 * 60_000);
    for (const title of ["Atlas finished A", "Ava finished B", "Atlas could not finish C"]) await holdPush("ws", { title, body: "", url: "/bot" }, morning);
    const { store } = await import("../agent/lib/store");
    const listing = vi.spyOn(store(), "list");
    expect(await flushPushQueue({ send, force: true })).toBe(0);
    expect(listing).not.toHaveBeenCalled();
    expect(await flushPushQueue({ send, force: true, now: morning.getTime() + 1000 })).toBe(1);
    expect(sent).toEqual([{ title: "While you were away: 3 updates", body: "Atlas finished A · Ava finished B · Atlas could not finish C", url: "/bot", tag: "while-away" }]);
  });
});
