import { createHash } from "node:crypto";

import webpush, { type PushSubscription, WebPushError } from "web-push";

import { sealWith, unsealWith } from "./seal";
import { deleteDoc, isConflict, listDocs, readDoc, updateDoc, writeDoc } from "./store";

/**
 * Push notifications to the console installed as an app (docs/plan/notifications.md).
 *
 * Standard Web Push: no vendor account. The server signs every push with its
 * own VAPID key pair, made the first time one is needed and kept in the store
 * with the private half sealed. Each person turns notifications on per device;
 * a device's subscription is kept under its workspace and dropped when its
 * push service says it is gone. A push that fails for a passing reason (the
 * service is down, rate-limited) is kept and tried again by the background
 * pass, a few times, while it is still worth seeing.
 */

const SEAL_LABEL = "bot-push";
export const VAPID_KEY = "push/_vapid.json";
const subscriptionKey = (workspaceId: string, id: string) => `push/${workspaceId}/${id}.json`;
const queuedKey = (workspaceId: string, id: string) => `push-queue/${workspaceId}/${id}.json`;
/** When the earliest queued push is due, so a pass with nothing due reads one small document instead of listing the queue. */
const NEXT_DUE_KEY = "push-queue-next.json";

/** Notes that something in the queue is due at `at`, if that is sooner than what is noted. */
async function noteDue(at: string): Promise<void> {
  await updateDoc<{ readonly at: string }>(NEXT_DUE_KEY, (current) => (current !== null && current.at <= at ? current : { at })).catch(() => undefined);
}

/** How long a push service keeps a notification for a device that is offline. */
const TTL_SECONDS = 24 * 60 * 60;
/** How long a just-subscribed device is not taken for gone. */
const NEW_DEVICE_MS = 2 * 60_000;
/** Waits before each retry of a push that failed for a passing reason; past the last, it is dropped. */
const RETRY_AFTER_MS = [60_000, 5 * 60_000, 30 * 60_000];

export interface PushMessage {
  readonly title: string;
  readonly body: string;
  /** Where clicking it goes, in the console. */
  readonly url: string;
  /** A newer notification with the same tag replaces the older one on the device. */
  readonly tag?: string;
  /** Needs the person now: delivered at once even to a device saving battery. */
  readonly urgent?: boolean;
  /** A test from Settings: shown even to someone looking at the console. */
  readonly test?: boolean;
  /** In Chrome, not shown while the console is focused (the person's "only when I'm away"). */
  readonly away?: boolean;
}

export interface Subscription {
  readonly id: string;
  readonly workspaceId: string;
  /** Who turned it on (`Access.user`). */
  readonly person: string;
  readonly endpoint: string;
  readonly keys: { readonly p256dh: string; readonly auth: string };
  /** What the device looks like to a person choosing which to remove ("iPhone", "Chrome on Mac"). */
  readonly device: string;
  readonly at: string;
}

interface VapidDoc {
  readonly publicKey: string;
  readonly sealedPrivateKey: string;
  readonly at: string;
}

interface Queued {
  readonly id: string;
  readonly workspaceId: string;
  readonly subscriptionId: string;
  readonly message: PushMessage;
  readonly attempts: number;
  readonly nextAt: string;
  readonly at: string;
  /** Kept through quiet hours rather than for a retry: several due at once go out as one summary. */
  readonly held?: boolean;
}

let vapid: Promise<{ publicKey: string; privateKey: string }> | null = null;

/** The deployment's VAPID keys, made once (two first requests at once agree on one pair). */
export function vapidKeys(): Promise<{ publicKey: string; privateKey: string }> {
  vapid ??= (async () => {
    const existing = (await readDoc<VapidDoc>(VAPID_KEY))?.value ?? null;
    if (existing !== null) return opened(existing);
    const made = webpush.generateVAPIDKeys();
    const doc: VapidDoc = { publicKey: made.publicKey, sealedPrivateKey: await sealWith(SEAL_LABEL, made.privateKey), at: new Date().toISOString() };
    try {
      await writeDoc(VAPID_KEY, doc, null);
    } catch (error) {
      if (!isConflict(error)) throw error;
    }
    // Whichever pair the store kept, never the one made here: several instances can make one at once, and a
    // device subscribed with one pair silently drops pushes signed with another.
    const landed = (await readDoc<VapidDoc>(VAPID_KEY))?.value;
    if (landed === undefined) throw new Error("The push key could not be saved.");
    return opened(landed);
  })().catch((error: unknown) => {
    vapid = null;
    throw error;
  });
  return vapid;
}

async function opened(doc: VapidDoc): Promise<{ publicKey: string; privateKey: string }> {
  const privateKey = await unsealWith(SEAL_LABEL, doc.sealedPrivateKey);
  if (privateKey === null) throw new Error("The push key could not be opened; the computer's key changed since it was made.");
  return { publicKey: doc.publicKey, privateKey };
}

/**
 * Who the pushes are from, which push services may use to reach the operator:
 * the deployment's https address, else the project's repository.
 */
export function vapidSubject(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const own = env.BOT_PUBLIC_URL?.trim() || (env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : "");
  return /^https:\/\//.test(own) ? own.replace(/\/+$/, "") : "https://github.com/Shaivpidadi/eve-bot";
}

export const subscriptionId = (endpoint: string): string => createHash("sha256").update(endpoint).digest("hex").slice(0, 24);

/** Whether `value` is a browser's push subscription, as `PushSubscription.toJSON()` gives it. */
export function isBrowserSubscription(value: unknown): value is { endpoint: string; keys: { p256dh: string; auth: string } } {
  if (typeof value !== "object" || value === null) return false;
  const { endpoint, keys } = value as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  return typeof endpoint === "string" && /^https:\/\//.test(endpoint) && typeof keys?.p256dh === "string" && typeof keys.auth === "string";
}

export async function subscribe(input: { workspaceId: string; person: string; subscription: { endpoint: string; keys: { p256dh: string; auth: string } }; device: string }): Promise<Subscription> {
  const id = subscriptionId(input.subscription.endpoint);
  const doc: Subscription = {
    id,
    workspaceId: input.workspaceId,
    person: input.person,
    endpoint: input.subscription.endpoint,
    keys: { p256dh: input.subscription.keys.p256dh, auth: input.subscription.keys.auth },
    device: input.device.slice(0, 60) || "A device",
    at: new Date().toISOString(),
  };
  await writeDoc(subscriptionKey(input.workspaceId, id), doc);
  return doc;
}

/** Removes one of this person's devices; false when it is not theirs or not there. */
export async function unsubscribe(workspaceId: string, person: string, id: string): Promise<boolean> {
  if (!/^[0-9a-f]{24}$/.test(id)) return false;
  const current = (await readDoc<Subscription>(subscriptionKey(workspaceId, id)))?.value ?? null;
  if (current === null || current.person !== person) return false;
  await deleteDoc(subscriptionKey(workspaceId, id));
  return true;
}

export async function subscriptions(workspaceId: string, person?: string): Promise<Subscription[]> {
  const all = await listDocs<Subscription>(`push/${workspaceId}/`);
  return all.filter((entry) => person === undefined || entry.person === person);
}

type Send = (subscription: PushSubscription, payload: string, options: webpush.RequestOptions) => Promise<unknown>;

/** What sending to one device came to. */
type Outcome = "sent" | "gone" | "retry" | "refused";

async function sendOne(subscription: Subscription, message: PushMessage, send: Send): Promise<Outcome> {
  const keys = await vapidKeys();
  try {
    await send({ endpoint: subscription.endpoint, keys: subscription.keys }, JSON.stringify(message), {
      vapidDetails: { subject: vapidSubject(), publicKey: keys.publicKey, privateKey: keys.privateKey },
      TTL: TTL_SECONDS,
      urgency: message.urgent === true ? "high" : "normal",
      timeout: 10_000,
    });
    return "sent";
  } catch (error) {
    const status = error instanceof WebPushError ? error.statusCode : null;
    // The device unsubscribed, or the browser dropped the subscription.
    if (status === 404 || status === 410) return "gone";
    // The service is down or busy, or the network failed: worth another try.
    if (status === null || status === 429 || status >= 500) return "retry";
    console.warn(`[push] ${subscription.device}: refused (${status}) ${error instanceof Error ? error.message.slice(0, 160) : ""}`);
    return "refused";
  }
}

/**
 * Sends `message` to every device subscribed in the workspace, or only to
 * `person`'s. Devices that are gone are forgotten; a passing failure is kept
 * for `flushPushQueue`.
 */
export async function sendPush(
  workspaceId: string,
  message: PushMessage,
  options: { readonly person?: string; readonly send?: Send } = {},
): Promise<{ sent: number; gone: number; queued: number; refused: number }> {
  const send = options.send ?? webpush.sendNotification;
  const counts = { sent: 0, gone: 0, queued: 0, refused: 0 };
  for (const subscription of await subscriptions(workspaceId, options.person)) {
    let outcome = await sendOne(subscription, message, send);
    // A device that subscribed moments ago can read as gone until its push service has caught up.
    if (outcome === "gone" && Date.now() - Date.parse(subscription.at) < NEW_DEVICE_MS) outcome = "retry";
    if (outcome === "sent") counts.sent += 1;
    else if (outcome === "gone") {
      counts.gone += 1;
      await deleteDoc(subscriptionKey(workspaceId, subscription.id)).catch(() => undefined);
    } else if (outcome === "retry") {
      counts.queued += 1;
      await queue(workspaceId, subscription.id, message, 0);
    } else counts.refused += 1;
  }
  return counts;
}

async function queue(workspaceId: string, subscriptionId: string, message: PushMessage, attempts: number): Promise<void> {
  const wait = RETRY_AFTER_MS[attempts];
  if (wait === undefined) return;
  const id = `${subscriptionId}-${createHash("sha256").update(JSON.stringify(message)).digest("hex").slice(0, 12)}`;
  const item: Queued = { id, workspaceId, subscriptionId, message, attempts: attempts + 1, nextAt: new Date(Date.now() + wait).toISOString(), at: new Date().toISOString() };
  await writeDoc(queuedKey(workspaceId, id), item).catch(() => undefined);
  await noteDue(item.nextAt);
}

/**
 * Keeps `message` for the workspace's devices (or `person`'s) until `until`,
 * the end of quiet hours, when the queue sends it with the next pass: the
 * console's poll, a recorded event, or the background worker.
 */
export async function holdPush(workspaceId: string, message: PushMessage, until: Date, person?: string): Promise<number> {
  const held = await subscriptions(workspaceId, person);
  for (const subscription of held) {
    const id = `${subscription.id}-${createHash("sha256").update(JSON.stringify(message)).digest("hex").slice(0, 12)}`;
    const item: Queued = { id, workspaceId, subscriptionId: subscription.id, message, attempts: 0, nextAt: until.toISOString(), at: new Date().toISOString(), held: true };
    await writeDoc(queuedKey(workspaceId, id), item).catch(() => undefined);
  }
  if (held.length > 0) await noteDue(until.toISOString());
  return held.length;
}

/** How many held pushes for one device go out as one summary rather than one by one. */
const SUMMARY_FROM = 3;

/** One notification for several held overnight: who did what, newest last. */
export function summaryOf(messages: readonly PushMessage[]): PushMessage {
  const lines = messages.map((message) => message.title);
  return {
    title: `While you were away: ${messages.length} updates`,
    body: lines.slice(0, 4).join(" · ") + (lines.length > 4 ? ` · and ${lines.length - 4} more` : ""),
    url: "/bot",
    tag: "while-away",
  };
}

/**
 * How often a server looks at the retry queue: the console's poll calls this
 * every few seconds, and each look is a billed store listing.
 */
const FLUSH_EVERY_MS = 60_000;
let lastFlush = 0;

/** Tries again the pushes that are due; called by the background pass and the console's board poll. */
export async function flushPushQueue(options: { readonly send?: Send; readonly now?: number; readonly force?: boolean } = {}): Promise<number> {
  const send = options.send ?? webpush.sendNotification;
  const now = options.now ?? Date.now();
  if (options.force !== true && now - lastFlush < FLUSH_EVERY_MS) return 0;
  lastFlush = now;
  const next = (await readDoc<{ at: string }>(NEXT_DUE_KEY).catch(() => null))?.value ?? null;
  if (next === null || Date.parse(next.at) > now) return 0;
  // Cleared before the pass; whatever stays queued notes itself again below.
  await deleteDoc(NEXT_DUE_KEY).catch(() => undefined);
  let delivered = 0;
  // Due items by device, so a night's worth of held ones can go out as one.
  const due = new Map<string, Queued[]>();
  for (const item of await listDocs<Queued>("push-queue/")) {
    if (Date.parse(item.nextAt) > now) {
      await noteDue(item.nextAt);
      continue;
    }
    await deleteDoc(queuedKey(item.workspaceId, item.id)).catch(() => undefined);
    // Not worth seeing any more once the push service would have dropped it too (counted from when it was due).
    if (now - Date.parse(item.nextAt) > TTL_SECONDS * 1000) continue;
    const key = `${item.workspaceId}/${item.subscriptionId}`;
    due.set(key, [...(due.get(key) ?? []), item]);
  }
  for (const items of due.values()) {
    const first = items[0]!;
    const subscription = (await readDoc<Subscription>(subscriptionKey(first.workspaceId, first.subscriptionId)))?.value ?? null;
    if (subscription === null) continue;
    const held = items.filter((item) => item.held === true).sort((left, right) => left.at.localeCompare(right.at));
    const batches: { message: PushMessage; attempts: number }[] = [
      ...(held.length >= SUMMARY_FROM ? [{ message: summaryOf(held.map((item) => item.message)), attempts: 0 }] : held.map((item) => ({ message: item.message, attempts: 0 }))),
      ...items.filter((item) => item.held !== true).map((item) => ({ message: item.message, attempts: item.attempts })),
    ];
    for (const batch of batches) {
      const outcome = await sendOne(subscription, batch.message, send);
      if (outcome === "sent") delivered += 1;
      else if (outcome === "gone") {
        await deleteDoc(subscriptionKey(subscription.workspaceId, subscription.id)).catch(() => undefined);
        break;
      } else if (outcome === "retry") await queue(subscription.workspaceId, subscription.id, batch.message, batch.attempts);
    }
  }
  return delivered;
}

/** "Chrome on Mac", "iPhone", …: enough to tell a person's devices apart. */
export function deviceName(userAgent: string | null): string {
  const agent = userAgent ?? "";
  const os = /iPhone/.test(agent) ? "iPhone" : /iPad/.test(agent) ? "iPad" : /Android/.test(agent) ? "Android" : /Mac OS X|Macintosh/.test(agent) ? "Mac" : /Windows/.test(agent) ? "Windows" : /Linux/.test(agent) ? "Linux" : "";
  if (os === "iPhone" || os === "iPad") return os;
  const browser = /Edg\//.test(agent) ? "Edge" : /Firefox\//.test(agent) ? "Firefox" : /Chrome\//.test(agent) ? "Chrome" : /Safari\//.test(agent) ? "Safari" : "";
  return [browser, os].filter((part) => part !== "").join(" on ") || "A device";
}
