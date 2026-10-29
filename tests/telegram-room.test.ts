import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Telegram chat as a room (agent/lib/rooms.ts TELEGRAM_ROOM): work started
 * there comes back there (a due job, a routine's report, a teammate's answer),
 * with HQ's desk taking it while no chat is paired, and the chat is not told
 * twice about what it already shows.
 */

const TOKEN = "123456789:AAH" + "x".repeat(32);

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv("BOT_STORE", "memory");
  vi.stubEnv("BOT_COMPUTER_KEY", "k".repeat(40));
});

const api = (async (url: string) => {
  const method = url.split("/").at(-1)!;
  if (method === "getMe") return Response.json({ ok: true, result: { id: 42, is_bot: true, first_name: "Desk", username: "desk_bot" } });
  return Response.json({ ok: true, result: true });
}) as unknown as typeof fetch;

async function paired(workspaceId = "default") {
  const telegram = await import("../agent/lib/telegram");
  const status = await telegram.connectTelegram({ workspaceId, token: TOKEN, by: "owner", origin: null, fetch: api });
  await telegram.pairTelegramChat(status.pairLink!.split("start=")[1]!, { id: "7", name: "Sam" });
  return telegram;
}

describe("the Telegram room", () => {
  it("tells HQ it is on Telegram", async () => {
    const { roomAttributes, TELEGRAM_ROOM } = await import("../agent/lib/rooms");
    expect(roomAttributes("default", TELEGRAM_ROOM)).toEqual({ workspaceId: "default", room: "telegram", channel: "telegram" });
    expect(roomAttributes("default", "desk")).toEqual({ workspaceId: "default", room: "desk" });
  });

  it("is the paired chat, for its own workspace only", async () => {
    const telegram = await import("../agent/lib/telegram");
    expect(await telegram.telegramChatFor("default")).toBeNull();
    await paired();
    expect(await telegram.telegramChatFor("default")).toEqual({ chatId: "7" });
    expect(await telegram.telegramChatFor("other")).toBeNull();
  });

  it("can take the standup", async () => {
    const { standupRoom } = await import("../agent/lib/standup");
    expect(standupRoom({ BOT_STANDUP_ROOM: "telegram" })).toBe("telegram");
  });
});

describe("delivering from a schedule", () => {
  it("goes to the chat through the Telegram channel, or to HQ's desk while none is paired", async () => {
    const [{ sendToRoomAs }, { default: ops }, { default: telegramChannel }] = await Promise.all([
      import("../agent/lib/room-delivery"),
      import("../agent/channels/ops"),
      import("../agent/channels/telegram"),
    ]);
    const sent: { channel: unknown; target: unknown; message: string; attributes: unknown }[] = [];
    const to = ((channel: unknown, target: unknown) => ({
      send: async (message: string, options: { auth: { attributes: unknown } }) => {
        sent.push({ channel, target, message, attributes: options.auth.attributes });
        return { id: "s" };
      },
    })) as never;
    const appAuth = { authenticator: "app", principalId: "eve:app", principalType: "runtime", attributes: {} } as never;

    await sendToRoomAs(to, appAuth, "default", "telegram", "Job job_1 is due");
    expect(sent.at(-1)).toMatchObject({ channel: ops, target: { workspaceId: "default", room: "desk" }, attributes: { room: "desk" } });

    await paired();
    await sendToRoomAs(to, appAuth, "default", "telegram", "Job job_1 is due");
    expect(sent.at(-1)).toMatchObject({ channel: telegramChannel, target: { chatId: "7" }, attributes: { room: "telegram", channel: "telegram" } });

    await sendToRoomAs(to, appAuth, "default", "bot-b1", "A note");
    expect(sent.at(-1)).toMatchObject({ channel: ops, target: { workspaceId: "default", room: "bot-b1" } });
  });
});

describe("a teammate's answer to HQ", () => {
  it("goes where HQ last wrote to that Bot from, for a day", async () => {
    const { hqRoomFor, postNote } = await import("../agent/lib/teammail");
    expect(await hqRoomFor("default", "bot-b1")).toBe("desk");
    await postNote({ workspaceId: "default", from: { name: "HQ", room: "telegram" }, to: { name: "Atlas", room: "bot-b1" }, text: "How is the report?" });
    expect(await hqRoomFor("default", "bot-b1")).toBe("telegram");
    expect(await hqRoomFor("default", "bot-b2")).toBe("desk");
    expect(await hqRoomFor("default", "bot-b1", Date.now() + 25 * 60 * 60_000)).toBe("desk");
    // Asked again from the desk: the answer goes back to the desk.
    await postNote({ workspaceId: "default", from: { name: "HQ", room: "desk" }, to: { name: "Atlas", room: "bot-b1" }, text: "Never mind." });
    expect(await hqRoomFor("default", "bot-b1")).toBe("desk");
  });

  it("is not changed by Bots writing to each other", async () => {
    const { hqRoomFor, postNote } = await import("../agent/lib/teammail");
    await postNote({ workspaceId: "default", from: { name: "HQ", room: "telegram" }, to: { name: "Atlas", room: "bot-b1" }, text: "Hi" });
    await postNote({ workspaceId: "default", from: { name: "Ava", room: "bot-b2" }, to: { name: "Atlas", room: "bot-b1" }, text: "Hi" });
    expect(await hqRoomFor("default", "bot-b1")).toBe("telegram");
  });
});

describe("alerts the chat already shows", () => {
  it("are not sent to it twice, but a browser takeover is", async () => {
    const { shownInTelegram } = await import("../agent/lib/notify");
    const jobs = await import("../agent/lib/jobs");
    expect(await shownInTelegram({ workspaceId: "default", jobId: null, data: { room: "telegram" } })).toBe(true);
    expect(await shownInTelegram({ workspaceId: "default", jobId: null, data: { room: "desk" } })).toBe(false);
    const fromChat = await jobs.assignJob({ workspaceId: "default", botId: "bot_1", requestedBy: "telegram:7", title: "Check", brief: "Check it.", room: "telegram" });
    const fromDesk = await jobs.assignJob({ workspaceId: "default", botId: "bot_1", requestedBy: "owner", title: "Check", brief: "Check it." });
    expect(await shownInTelegram({ workspaceId: "default", jobId: fromChat.id, data: {} })).toBe(true);
    expect(await shownInTelegram({ workspaceId: "default", jobId: fromDesk.id, data: {} })).toBe(false);
    expect(await shownInTelegram({ workspaceId: "default", jobId: fromChat.id, data: { takeover: true } })).toBe(false);
  });

  it("still go to the chat for work started on the desk", async () => {
    const api2 = { calls: [] as string[] };
    vi.stubGlobal("fetch", (async (url: string, init: RequestInit) => {
      api2.calls.push(`${url.split("/").at(-1)} ${String(init.body)}`);
      return api(url);
    }) as unknown as typeof fetch);
    try {
      await paired();
      const { deliver } = await import("../agent/lib/notify");
      const alert = { kind: "needs-you", title: "Atlas needs you", body: "Approve?", url: "/bot?thread=b1", tag: "t", urgent: true } as const;
      expect(await deliver("default", alert, { telegram: false })).toBe(0);
      expect(await deliver("default", alert)).toBe(1);
      expect(api2.calls.filter((call) => call.startsWith("sendMessage"))).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
