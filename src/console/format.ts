import type { Presence, Routine } from "./types";

export const PRESENCE_LABEL: Readonly<Record<Presence, string>> = {
  idle: "Idle",
  thinking: "Thinking",
  working: "Working",
  waiting: "Needs you",
  blocked: "Blocked",
  done: "Done",
};

/** The feed prefixes some lines with a Bot's emoji; the avatar system replaces it in the console. */
export const withoutEmoji = (text: string): string => text.replace(/^\p{Extended_Pictographic}️?\s*/u, "");

export const sameDay =(left: Date, right: Date): boolean => left.toDateString() === right.toDateString();

export const clock = (date: Date): string =>
  date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** "7:34 PM" today, then "Yesterday", a weekday this week, and a date after that. */
export function shortWhen(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  const now = new Date();
  if (sameDay(date, now)) return clock(date);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(date, yesterday)) return "Yesterday";
  if (now.getTime() - date.getTime() < 6 * 86_400_000) {
    return date.toLocaleDateString([], { weekday: "long" });
  }
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

export function dividerWhen(iso: string): string {
  const date = new Date(iso);
  return sameDay(date, new Date()) ? clock(date) : `${shortWhen(iso)} ${clock(date)}`;
}

/** A time divider goes in after a half-hour gap, or when the day changes. */
export function needsDivider(previous: string | null, next: string): boolean {
  if (previous === null) return true;
  const before = new Date(previous);
  const after = new Date(next);
  return after.getTime() - before.getTime() > 30 * 60_000 || !sameDay(before, after);
}

export function scheduleText(routine: Routine, paused: boolean): string {
  if (paused) return "Paused";
  const next = new Date(routine.nextRunAt);
  const at = clock(next);
  const every = routine.everyMinutes;
  if (every === null) {
    return `Once, ${shortWhen(routine.nextRunAt)}${sameDay(next, new Date()) ? "" : ` at ${at}`}`;
  }
  if (every === 1440) return `Every day at ${at}`;
  if (every === 10080) return `Every ${next.toLocaleDateString([], { weekday: "long" })} at ${at}`;
  if (every % 1440 === 0) return `Every ${every / 1440} days at ${at}`;
  if (every === 60) return "Every hour";
  if (every % 60 === 0) return `Every ${every / 60} hours`;
  return `Every ${every} minutes`;
}

export function bytes(count: number): string {
  if (count < 1024) return `${count} B`;
  if (count < 1_048_576) return `${Math.round(count / 1024)} KB`;
  return `${(count / 1_048_576).toFixed(1)} MB`;
}
