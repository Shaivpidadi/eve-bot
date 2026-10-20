import { WebPushError } from "web-push";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Push notifications (agent/lib/push.ts): the deployment's keys are made once
 * and kept sealed, each person turns devices on and off, a device that is gone
 * is forgotten, and a passing failure is tried again.
 */

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv("BOT_STORE", "memory");
  vi.stubEnv("BOT_COMPUTER_KEY", "k".repeat(40));
});

const load = () => import("../agent/lib/push");
const browser = (n: number) => ({ endpoint: `https://push.example/${n}`, keys: { p256dh: "BNcR".padEnd(87, "A"), auth: "tBHI".padEnd(22, "A") } });
const message = { title: "T", body: "B", url: "/bot" };
const failing = (status: number) => async () => {
  throw new WebPushError("no", status, {}, "", "https://push.example");
};

describe("keys", () => {
  it("are made once, the private half sealed in the store", async () => {
    const { vapidKeys, VAPID_KEY } = await load();
    const [first, again] = await Promise.all([vapidKeys(), vapidKeys()]);
    expect(again).toEqual(first);
    expect(first.publicKey).toMatch(/^[A-Za-z0-9_-]{80,}$/);
    const { store } = await import("../agent/lib/store");
    const saved = (await store().get(VAPID_KEY))!.value;
    expect(saved).toContain(first.publicKey);
    expect(saved).not.toContain(first.privateKey);
  });
});

describe("devices", () => {
  it("are each person's own to turn off", async () => {
    const { subscribe, subscriptions, unsubscribe } = await load();
    const ann = await subscribe({ workspaceId: "ws", person: "ann", subscription: browser(1), device: "iPhone" });
    await subscribe({ workspaceId: "ws", person: "bob", subscription: browser(2), device: "Chrome on Mac" });
    expect((await subscriptions("ws", "ann")).map((entry) => entry.device)).toEqual(["iPhone"]);
    expect(await unsubscribe("ws", "bob", ann.id)).toBe(false);
    expect(await unsubscribe("ws", "ann", ann.id)).toBe(true);
    expect(await subscriptions("ws")).toHaveLength(1);
  });
});

describe("sending", () => {
  it("reaches a person's devices, forgets one that is gone, and keeps a passing failure for later", async () => {
    const { flushPushQueue, sendPush, subscribe, subscriptions } = await load();
    await subscribe({ workspaceId: "ws", person: "ann", subscription: browser(1), device: "iPhone" });
    const sent = vi.fn(async () => undefined);
    expect(await sendPush("ws", message, { person: "ann", send: sent })).toMatchObject({ sent: 1 });
    expect(sent).toHaveBeenCalledWith(browser(1), JSON.stringify(message), expect.objectContaining({ TTL: 86_400, urgency: "normal" }));

    // The push service is down: kept, and tried again once it is due.
    expect(await sendPush("ws", message, { send: failing(503) })).toMatchObject({ sent: 0, queued: 1 });
    expect(await flushPushQueue({ send: sent, force: true })).toBe(0);
    expect(await flushPushQueue({ send: sent, force: true, now: Date.now() + 2 * 60_000 })).toBe(1);

    // Just subscribed, it is not taken for gone yet; later, it is forgotten.
    expect(await sendPush("ws", message, { send: failing(410) })).toMatchObject({ gone: 0, queued: 1 });
    vi.useFakeTimers({ now: Date.now() + 3 * 60_000, toFake: ["Date"] });
    expect(await sendPush("ws", message, { send: failing(410) })).toMatchObject({ gone: 1 });
    vi.useRealTimers();
    expect(await subscriptions("ws")).toHaveLength(0);
  });

  it("does not try again what the push service refused outright", async () => {
    const { flushPushQueue, sendPush, subscribe } = await load();
    await subscribe({ workspaceId: "ws", person: "ann", subscription: browser(1), device: "iPhone" });
    expect(await sendPush("ws", message, { send: failing(403) })).toMatchObject({ refused: 1, queued: 0 });
    expect(await flushPushQueue({ send: vi.fn(), force: true, now: Date.now() + 60 * 60_000 })).toBe(0);
  });
});

describe("exports", () => {
  it("count push keys and subscriptions as secret", async () => {
    const { isSecretKey } = await import("../agent/lib/store/transfer");
    expect(isSecretKey("push/_vapid.json")).toBe(true);
    expect(isSecretKey("push/ws/abc.json")).toBe(true);
    expect(isSecretKey("push-queue/ws/abc.json")).toBe(true);
  });
});

describe("deviceName", () => {
  it("tells a person's devices apart", async () => {
    const { deviceName } = await load();
    expect(deviceName("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1")).toBe("iPhone");
    expect(deviceName("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36")).toBe("Chrome on Mac");
    expect(deviceName(null)).toBe("A device");
  });
});
