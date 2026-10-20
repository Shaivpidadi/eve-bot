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
      expect(sent).toEqual([{ title: "HQ needs you", body: "Send the email?", url: "/bot?thread=hq", tag: "ask-hq", urgent: true }]);
    } finally {
      vi.doUnmock("web-push");
    }
  });
});
