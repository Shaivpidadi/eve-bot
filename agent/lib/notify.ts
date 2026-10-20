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
  readonly kind: "needs-you" | "done";
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

const QUIET_FROM_HOUR = 22;
const QUIET_TO_HOUR = 8;
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

/** When quiet hours end, if `now` falls in them in `timezone`; null when they do not. */
export function quietUntil(now: Date, timezone: string): Date | null {
  const { hour, minute } = localTime(now, timezone);
  const quiet = hour >= QUIET_FROM_HOUR || hour < QUIET_TO_HOUR;
  if (!quiet) return null;
  // Minutes until 08:00 local, counted forward from now; a minute's rounding does not matter here.
  const minutesNow = hour * 60 + minute;
  const end = QUIET_TO_HOUR * 60;
  const wait = (end - minutesNow + 24 * 60) % (24 * 60);
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
 * Sends the push an event makes to every device in its workspace, or holds it
 * through quiet hours. Never throws: a notification lost is better than an
 * event lost. The store, the Bots and the push sender are loaded only here.
 */
export async function notifyFor(event: ActivityEvent): Promise<void> {
  if (!NOTIFYING.has(event.kind)) return;
  try {
    const [{ getBot }, { holdPush, sendPush }] = await Promise.all([import("./bots"), import("./push")]);
    const bot = event.botId === null ? null : await getBot(event.workspaceId, event.botId).catch(() => null);
    const alert = alertFor(event, event.botId === null ? null : (bot?.name ?? "A Bot"));
    if (alert === null || repeated(event.workspaceId, alert.tag, Date.now())) return;
    const message = { title: alert.title, body: alert.body, url: alert.url, tag: alert.tag, urgent: alert.urgent };
    if (!alert.urgent) {
      const [{ effectiveEnv }, { defaultTimezone }] = await Promise.all([import("./settings/store"), import("./schedule")]);
      const until = quietUntil(new Date(), defaultTimezone(await effectiveEnv(event.workspaceId).catch(() => process.env)));
      if (until !== null) {
        await holdPush(event.workspaceId, message, until);
        return;
      }
    }
    await sendPush(event.workspaceId, message);
  } catch (error) {
    console.warn("[push] could not notify:", error instanceof Error ? error.message : String(error));
  }
}
