import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Telegram from the console (agent/lib/telegram.ts): a pasted token is
 * checked, the bot set up for where the server runs (a webhook on a public
 * https address, polling anywhere else), one chat pairs with the link, and the
 * token never leaves sealed.
 */

const TOKEN = "123456789:AAH" + "x".repeat(32);

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv("BOT_STORE", "memory");
  vi.stubEnv("BOT_COMPUTER_KEY", "k".repeat(40));
});

/** A Bot API that answers getMe and records every call. */
function fakeApi(over: Record<string, unknown> = {}) {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  const call = (async (url: string, init: RequestInit) => {
    const method = url.split("/").at(-1)!;
    calls.push({ method, body: JSON.parse(String(init.body)) });
    if (method in over) return Response.json(over[method]);
    if (method === "getMe") return Response.json({ ok: true, result: { id: 42, is_bot: true, first_name: "Desk", username: "desk_bot" } });
    return Response.json({ ok: true, result: true });
  }) as unknown as typeof fetch;
  return { call, calls };
}

describe("where updates come from", () => {
  it("is a webhook only on a public https address", async () => {
    const { modeFor } = await import("../agent/lib/telegram");
    expect(modeFor("https://bot.example.com")).toBe("webhook");
    expect(modeFor("https://my-app.vercel.app")).toBe("webhook");
    for (const local of [null, "http://127.0.0.1:3000", "http://bot.example.com", "https://localhost:3000", "https://192.168.1.5", "https://172.16.10.121", "https://mybox", "https://mac.local"]) {
      expect(modeFor(local)).toBe("polling");
    }
  });
});

describe("connecting", () => {
  it("registers the webhook with its secret on Vercel and keeps the token sealed", async () => {
    const telegram = await import("../agent/lib/telegram");
    const api = fakeApi();
    const status = await telegram.connectTelegram({ workspaceId: "default", token: TOKEN, by: "owner", origin: "https://bot.example.com", fetch: api.call });
    expect(status).toMatchObject({ username: "desk_bot", mode: "webhook", webhookUrl: "https://bot.example.com/eve/v1/telegram", chat: null });
    expect(status.pairLink).toMatch(/^https:\/\/t\.me\/desk_bot\?start=[\w-]{16}$/);
    const hook = api.calls.find((c) => c.method === "setWebhook")!;
    const link = (await telegram.readTelegramLink())!;
    expect(hook.body).toMatchObject({ url: "https://bot.example.com/eve/v1/telegram", secret_token: link.secret });
    expect(JSON.stringify(link)).not.toContain(TOKEN);
    expect(JSON.stringify(status)).not.toContain(link.secret);
    expect(await telegram.telegramToken()).toBe(TOKEN);
  });

  it("polls on a laptop, after clearing any webhook", async () => {
    const telegram = await import("../agent/lib/telegram");
    const api = fakeApi();
    expect(await telegram.connectTelegram({ workspaceId: "default", token: TOKEN, by: "owner", origin: "http://127.0.0.1:3000", fetch: api.call })).toMatchObject({ mode: "polling", webhookUrl: null });
    expect(api.calls.map((c) => c.method)).toEqual(["getMe", "deleteWebhook"]);
  });

  it("refuses what is not a bot token, and never repeats the token in an error", async () => {
    const telegram = await import("../agent/lib/telegram");
    await expect(telegram.connectTelegram({ workspaceId: "default", token: "hello", by: "owner", origin: null })).rejects.toThrow("not a bot token");
    const api = fakeApi({ getMe: { ok: false, description: `Unauthorized for bot${TOKEN}` } });
    const failed = telegram.connectTelegram({ workspaceId: "default", token: TOKEN, by: "owner", origin: null, fetch: api.call });
    await expect(failed).rejects.toThrow("Unauthorized");
    await expect(failed).rejects.not.toThrow(TOKEN);
    expect(await telegram.readTelegramLink()).toBeNull();
  });

  it("keeps the paired chat when the same bot reconnects", async () => {
    const telegram = await import("../agent/lib/telegram");
    const api = fakeApi();
    const first = await telegram.connectTelegram({ workspaceId: "default", token: TOKEN, by: "owner", origin: null, fetch: api.call });
    await telegram.pairTelegramChat(first.pairLink!.split("start=")[1]!, { id: "7", name: "Sam" });
    expect(await telegram.connectTelegram({ workspaceId: "default", token: TOKEN, by: "owner", origin: "https://bot.example.com", fetch: api.call })).toMatchObject({ mode: "webhook", chat: { name: "Sam" }, pairLink: null });
  });
});

describe("pairing", () => {
  it("pairs the first chat with the right code, once", async () => {
    const telegram = await import("../agent/lib/telegram");
    const status = await telegram.connectTelegram({ workspaceId: "default", token: TOKEN, by: "owner", origin: null, fetch: fakeApi().call });
    const code = status.pairLink!.split("start=")[1]!;
    expect(await telegram.pairTelegramChat("wrong", { id: "9", name: "Stranger" })).toBeNull();
    expect(await telegram.pairTelegramChat(code, { id: "7", name: "Sam" })).toMatchObject({ id: "7", name: "Sam" });
    // The code is spent, and a paired link takes no other chat.
    expect(await telegram.pairTelegramChat(code, { id: "9", name: "Stranger" })).toBeNull();
    expect((await telegram.readTelegramLink())!.chat).toMatchObject({ id: "7" });
  });

  it("lets another chat pair after the console asks for a new link", async () => {
    const telegram = await import("../agent/lib/telegram");
    const status = await telegram.connectTelegram({ workspaceId: "default", token: TOKEN, by: "owner", origin: null, fetch: fakeApi().call });
    await telegram.pairTelegramChat(status.pairLink!.split("start=")[1]!, { id: "7", name: "Sam" });
    const again = (await telegram.repairTelegram())!;
    expect(again.chat).toBeNull();
    expect(await telegram.pairTelegramChat(again.pairLink!.split("start=")[1]!, { id: "8", name: "Sam's phone" })).toMatchObject({ id: "8" });
  });
});

describe("disconnecting", () => {
  it("drops the webhook and forgets the bot", async () => {
    const telegram = await import("../agent/lib/telegram");
    const api = fakeApi();
    await telegram.connectTelegram({ workspaceId: "default", token: TOKEN, by: "owner", origin: "https://bot.example.com", fetch: api.call });
    await telegram.disconnectTelegram(api.call);
    expect(api.calls.at(-1)!.method).toBe("deleteWebhook");
    expect(await telegram.readTelegramLink()).toBeNull();
  });
});

describe("polling on a laptop", () => {
  it("hands each update to the channel route in order, with the secret, and saves the offset", async () => {
    const telegram = await import("../agent/lib/telegram");
    const { pollOnce } = await import("../agent/lib/telegram-poll");
    const posted: { url: string; secret: string | null; body: unknown }[] = [];
    let asked: Record<string, unknown> = {};
    const call = (async (url: string, init: RequestInit) => {
      if (url.startsWith("http://agent")) {
        posted.push({ url, secret: new Headers(init.headers).get("x-telegram-bot-api-secret-token"), body: JSON.parse(String(init.body)) });
        return new Response(null, { status: 200 });
      }
      const method = url.split("/").at(-1)!;
      if (method === "getMe") return Response.json({ ok: true, result: { id: 42, is_bot: true, first_name: "Desk", username: "desk_bot" } });
      if (method === "getUpdates") {
        asked = JSON.parse(String(init.body));
        return Response.json({ ok: true, result: [{ update_id: 10, message: { text: "a" } }, { update_id: 11, message: { text: "b" } }] });
      }
      return Response.json({ ok: true, result: true });
    }) as unknown as typeof fetch;
    await telegram.connectTelegram({ workspaceId: "default", token: TOKEN, by: "owner", origin: null, fetch: call });

    expect(await pollOnce({ fetch: call, target: async () => "http://agent" })).toBe(2);
    const link = (await telegram.readTelegramLink())!;
    expect(asked).toMatchObject({ offset: 0, timeout: 25 });
    expect(posted.map((p) => [p.url, p.secret, (p.body as { update_id: number }).update_id])).toEqual([
      ["http://agent/eve/v1/telegram", link.secret, 10],
      ["http://agent/eve/v1/telegram", link.secret, 11],
    ]);
    expect((await telegram.readTelegramLink())!.offset).toBe(12);
  });

  it("does nothing for a webhook bot or none at all", async () => {
    const { pollOnce } = await import("../agent/lib/telegram-poll");
    expect(await pollOnce({ target: async () => "http://agent" })).toBeNull();
    const telegram = await import("../agent/lib/telegram");
    await telegram.connectTelegram({ workspaceId: "default", token: TOKEN, by: "owner", origin: "https://bot.example.com", fetch: fakeApi().call });
    expect(await pollOnce({ target: async () => "http://agent" })).toBeNull();
  });
});

describe("alerts", () => {
  it("reach the paired chat: needs-you always, nothing for another workspace", async () => {
    const telegram = await import("../agent/lib/telegram");
    const api = fakeApi();
    vi.stubGlobal("fetch", api.call);
    try {
      const status = await telegram.connectTelegram({ workspaceId: "default", token: TOKEN, by: "owner", origin: null, fetch: api.call });
      const { deliver } = await import("../agent/lib/notify");
      const alert = { kind: "needs-you", title: "Atlas needs you", body: "Approve the refund?", url: "/bot?thread=bot_a", tag: "ask-bot_a", urgent: true } as const;
      // Nothing paired yet.
      expect(await deliver("default", alert)).toBe(0);
      await telegram.pairTelegramChat(status.pairLink!.split("start=")[1]!, { id: "7", name: "Sam" });
      expect(await deliver("default", alert)).toBe(1);
      const sent = api.calls.filter((c) => c.method === "sendMessage");
      expect(sent).toHaveLength(1);
      // Polling means the console is not reachable from the phone, so no link.
      expect(sent[0]!.body).toMatchObject({ chat_id: "7", text: "Atlas needs you\nApprove the refund?" });
      expect(await deliver("other", alert)).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
