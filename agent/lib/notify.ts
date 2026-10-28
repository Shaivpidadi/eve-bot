import type { ActivityEvent, ActivityKind } from "./types";

/**
 * Which events reach a person's devices, and when (docs/plan/notifications.md, N3).
 *
 * Every event passes through `record()`; only two kinds ever become a push:
 *
 * - **Needs you:** a Bot asks for an approval or an answer, or a job waits on
 *   a person (a sign-off, a question, a note to act on). Sent at once, even in
 *   quiet hours, and kept on screen until seen.
 * - **Done:** a job finished, or failed for good. Held through quiet hours
 *   (22:00 to 08:00 in the workspace's timezone) and sent at their end.
 *
 * Everything else (steps, memory, a routine with nothing new) stays silent.
 * A push is a link: pressing it opens the Bot's thread, where the approval
 * card or the result is; nothing is approved from a notification.
 */

export interface Alert {
  /** Needs you, a job that ended, or a Bot's own news (`nudge`): what a person can turn off (push-prefs.ts). */
  readonly kind: "needs-you" | "done" | "news";
  readonly title: string;
  readonly body: string;
  /** The thread to open: the Bot's, or HQ's. */
  readonly url: string;
  /** One per job or per Bot's question, so a newer push replaces the older one on the device. */
  readonly tag: string;
  readonly urgent: boolean;
}

/** The kinds that can notify; anything else is never looked at twice. */
export const NOTIFYING: ReadonlySet<ActivityKind> = new Set<ActivityKind>(["input.requested", "job.blocked", "job.done", "job.failed"]);

const BODY_MAX = 180;

const clip = (text: string) => (text.length > BODY_MAX ? `${text.slice(0, BODY_MAX - 1).trimEnd()}…` : text);
const threadUrl = (botId: string | null) => `/bot?thread=${encodeURIComponent(botId ?? "hq")}`;

/** The push an event makes, if any. `who` is the Bot's name, or null for HQ. */
export function alertFor(event: Pick<ActivityEvent, "kind" | "botId" | "jobId" | "text" | "data">, who: string | null): Alert | null {
  const name = who ?? "HQ";
  const data = event.data ?? {};
  const url = threadUrl(event.botId);
  switch (event.kind) {
    case "input.requested":
      return {
        kind: "needs-you",
        title: `${name} needs you`,
        body: clip(event.text.replace(/^Waiting on a human:\s*/i, "")),
        url,
        tag: `ask-${event.botId ?? "hq"}`,
        urgent: true,
      };
    case "job.blocked":
      if (data.sentBack === true) return null;
      return { kind: "needs-you", title: `${name} is waiting on you`, body: clip(event.text), url, tag: `job-${event.jobId ?? event.botId ?? "hq"}`, urgent: true };
    case "job.done": {
      const title = typeof data.title === "string" ? data.title : null;
      const summary = typeof data.summary === "string" ? data.summary : event.text;
      return { kind: "done", title: `${name} finished${title ? ` "${clip(title)}"` : ""}`, body: clip(summary), url, tag: `job-${event.jobId ?? "hq"}`, urgent: false };
    }
    case "job.failed":
      // A failed turn in a thread is shown there as it happens; only a job that gave up is news.
      if (data.turn === true || event.jobId === null) return null;
      return {
        kind: "done",
        title: `${name} could not finish${typeof data.title === "string" ? ` "${clip(data.title)}"` : ""}`,
        body: clip(typeof data.error === "string" ? data.error : event.text),
        url,
        tag: `job-${event.jobId}`,
        urgent: false,
      };
    default:
      return null;
  }
}

/** The hour and minute it is in `timezone`, or in UTC when that is not a zone Intl knows. */
function localTime(now: Date, timezone: string): { hour: number; minute: number } {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
    const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
    return { hour: value("hour"), minute: value("minute") };
  } catch {
    return { hour: now.getUTCHours(), minute: now.getUTCMinutes() };
  }
}

/**
 * When quiet hours end, if `now` falls in them in `timezone`; null when they
 * do not. `from` and `to` are whole hours, across midnight or not; equal, none.
 */
export function quietUntil(now: Date, timezone: string, from = 22, to = 8): Date | null {
  if (from === to) return null;
  const { hour, minute } = localTime(now, timezone);
  const quiet = from > to ? hour >= from || hour < to : hour >= from && hour < to;
  if (!quiet) return null;
  // Minutes until `to` o'clock local, counted forward from now.
  const minutesNow = hour * 60 + minute;
  const wait = (to * 60 - minutesNow + 24 * 60) % (24 * 60);
  return new Date(now.getTime() + wait * 60_000);
}

/** Tags sent lately, per workspace: one event is sometimes recorded twice (a browser takeover is). */
const recent = new Map<string, number>();
const REPEAT_MS = 30_000;

function repeated(workspaceId: string, tag: string, now: number): boolean {
  const key = `${workspaceId}:${tag}`;
  const last = recent.get(key);
  for (const [entry, at] of recent) if (now - at > REPEAT_MS) recent.delete(entry);
  recent.set(key, now);
  return last !== undefined && now - last < REPEAT_MS;
}

/**
 * Sends an alert to each person in the workspace with a device on, as their
 * preferences say (push-prefs.ts): the kinds they want, held through their
 * quiet hours unless it needs them. Returns how many people it reached or
 * holds for. The store and the push sender are loaded only here.
 */
export async function deliver(workspaceId: string, alert: Alert, options: { readonly telegram?: boolean } = {}): Promise<number> {
  const [{ holdPush, sendPush, subscriptions }, { readPrefs }] = await Promise.all([import("./push"), import("./push-prefs")]);
  const telegram = options.telegram === false ? 0 : await toTelegram(workspaceId, alert).catch(() => 0);
  const people = [...new Set((await subscriptions(workspaceId)).map((subscription) => subscription.person))];
  if (people.length === 0) return telegram;
  const [{ effectiveEnv }, { defaultTimezone }] = await Promise.all([import("./settings/store"), import("./schedule")]);
  const timezone = defaultTimezone(await effectiveEnv(workspaceId).catch(() => process.env));
  let reached = 0;
  for (const person of people) {
    const prefs = await readPrefs(workspaceId, person);
    const wanted = alert.kind === "needs-you" ? prefs.needsYou : alert.kind === "done" ? prefs.done : prefs.fromBots;
    if (!wanted) continue;
    const message = { title: alert.title, body: alert.body, url: alert.url, tag: alert.tag, urgent: alert.urgent, away: prefs.onlyWhenAway };
    const until = alert.urgent ? null : quietUntil(new Date(), timezone, prefs.quietFrom, prefs.quietTo);
    if (until !== null) await holdPush(workspaceId, message, until, person);
    else await sendPush(workspaceId, message, { person });
    reached += 1;
  }
  return reached + telegram;
}

/**
 * Whether the Telegram chat already shows what the event is about: its
 * question or approval as buttons, or HQ's report of the job, because the
 * work belongs to the Telegram room. A browser takeover is the exception: it
 * is done from the console, so the chat is told.
 */
export async function shownInTelegram(event: Pick<ActivityEvent, "workspaceId" | "jobId" | "data">): Promise<boolean> {
  const data = event.data ?? {};
  if (data.takeover === true) return false;
  const { TELEGRAM_ROOM } = await import("./rooms");
  if (typeof data.room === "string") return data.room === TELEGRAM_ROOM;
  if (event.jobId === null) return false;
  const { getJob } = await import("./jobs");
  return (await getJob(event.workspaceId, event.jobId).catch(() => null))?.room === TELEGRAM_ROOM;
}

/**
 * The same alert to the paired Telegram chat (see lib/telegram.ts), as the
 * person who connected it chose for their devices; outside quiet hours unless
 * it needs them, and dropped rather than held. A link to the console when it
 * is reachable from the phone.
 */
async function toTelegram(workspaceId: string, alert: Alert): Promise<number> {
  const { readTelegramLink, sendToPairedChat, telegramOrigin, modeFor } = await import("./telegram");
  const link = await readTelegramLink();
  if (link === null || link.chat === null || link.workspaceId !== workspaceId) return 0;
  const [{ readPrefs }, { effectiveEnv }, { defaultTimezone }] = await Promise.all([import("./push-prefs"), import("./settings/store"), import("./schedule")]);
  const prefs = await readPrefs(workspaceId, link.by);
  const wanted = alert.kind === "needs-you" ? prefs.needsYou : alert.kind === "done" ? prefs.done : prefs.fromBots;
  if (!wanted) return 0;
  const timezone = defaultTimezone(await effectiveEnv(workspaceId).catch(() => process.env));
  if (!alert.urgent && quietUntil(new Date(), timezone, prefs.quietFrom, prefs.quietTo) !== null) return 0;
  const origin = await telegramOrigin().catch(() => null);
  const open = origin !== null && modeFor(origin) === "webhook" ? `\n\n${origin}${alert.url}` : "";
  return (await sendToPairedChat(`${alert.title}\n${alert.body}${open}`)) ? 1 : 0;
}

/**
 * Sends the push an event makes, if it makes one. Never throws: a
 * notification lost is better than an event lost.
 */
export async function notifyFor(event: ActivityEvent): Promise<void> {
  if (!NOTIFYING.has(event.kind)) return;
  try {
    const { getBot } = await import("./bots");
    const bot = event.botId === null ? null : await getBot(event.workspaceId, event.botId).catch(() => null);
    const alert = alertFor(event, event.botId === null ? null : (bot?.name ?? "A Bot"));
    if (alert === null || repeated(event.workspaceId, alert.tag, Date.now())) return;
    await deliver(event.workspaceId, alert, { telegram: !(await shownInTelegram(event)) });
  } catch (error) {
    console.warn("[push] could not notify:", error instanceof Error ? error.message : String(error));
  }
}

// ---------------------------------------------------------------------------
// A Bot's own news (N4)
// ---------------------------------------------------------------------------

/** How much news a workspace's Bots may send: an assistant that reaches out too often gets turned off. */
export const NEWS_PER_HOUR = 3;
export const NEWS_PER_DAY = 10;
const NEWS_KEY = (workspaceId: string) => `push-sent/${workspaceId}.json`;

interface NewsLog {
  readonly sent: readonly { readonly at: string; readonly key: string }[];
}

export type NudgeResult =
  | { readonly sent: true; readonly reached: number; readonly note: string }
  | { readonly sent: false; readonly reason: string };

/**
 * A Bot or HQ tells the people in its workspace something new, unprompted:
 * news a routine found, a change worth knowing now. The same news (by `key`,
 * else its words) goes once a day; past the limits it waits for the next run.
 */
export async function nudge(input: { workspaceId: string; botId: string | null; who: string | null; title: string; message: string; key?: string }): Promise<NudgeResult> {
  const { updateDoc } = await import("./store");
  const key = (input.key?.trim() || `${input.title}\n${input.message}`).slice(0, 200);
  const now = Date.now();
  let refused: string | null = null;
  await updateDoc<NewsLog>(NEWS_KEY(input.workspaceId), (current) => {
    const sent = (current?.sent ?? []).filter((entry) => now - Date.parse(entry.at) < 24 * 60 * 60_000);
    if (sent.some((entry) => entry.key === key)) refused = "The same news already went out in the last day.";
    else if (sent.filter((entry) => now - Date.parse(entry.at) < 60 * 60_000).length >= NEWS_PER_HOUR) refused = `${NEWS_PER_HOUR} notifications already went out this hour; try on the next run.`;
    else if (sent.length >= NEWS_PER_DAY) refused = `${NEWS_PER_DAY} notifications already went out today; try tomorrow.`;
    return refused === null ? { sent: [...sent, { at: new Date(now).toISOString(), key }] } : { sent };
  });
  if (refused !== null) return { sent: false, reason: refused };
  const name = input.who ?? "HQ";
  const alert: Alert = {
    kind: "news",
    title: clip(`${name}: ${input.title}`),
    body: clip(input.message),
    url: threadUrl(input.botId),
    tag: `news-${createTagHash(key)}`,
    urgent: false,
  };
  const reached = await deliver(input.workspaceId, alert);
  return reached === 0
    ? { sent: true, reached: 0, note: "Nobody in this workspace has notifications on, or wants news from Bots; it was not sent." }
    : { sent: true, reached, note: "Sent, or held until the person's quiet hours end." };
}

/** A short stable tag from a key, without a hash library (this module stays free of imports). */
function createTagHash(key: string): string {
  let hash = 5381;
  for (let index = 0; index < key.length; index += 1) hash = ((hash << 5) + hash + key.charCodeAt(index)) | 0;
  return (hash >>> 0).toString(36);
}
