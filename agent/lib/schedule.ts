/**
 * "Every weekday at 9" is not "every 1440 minutes".
 *
 * A routine has repeated by waiting `everyMinutes` after the last cycle
 * *finished*, so a job that takes six minutes drifts six minutes later every
 * day, and an interval is the only thing anyone can ask for. What operators
 * actually want is a clock time in their own timezone, which also has to
 * survive the twice-yearly hour that does not exist and the one that happens
 * twice.
 *
 * So a routine may carry a clock schedule instead, and the next run is
 * computed from the wall clock rather than from when the last one ended.
 */

export const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type Day = (typeof DAYS)[number];

export interface Schedule {
  /** Hour of the day, 0-23, in `timezone`. */
  readonly hour: number;
  /** Minute of the hour, 0-59. */
  readonly minute: number;
  /** Days it runs. Empty or absent means every day. */
  readonly days?: readonly Day[];
  /** An IANA timezone, such as `America/New_York`. */
  readonly timezone: string;
}

/** Whether a timezone is one this runtime knows, so a typo fails loudly and early. */
export function isTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

export function isSchedule(value: unknown): value is Schedule {
  if (typeof value !== "object" || value === null) return false;
  const { hour, minute, days, timezone } = value as Partial<Schedule>;
  if (!Number.isInteger(hour) || (hour as number) < 0 || (hour as number) > 23) return false;
  if (!Number.isInteger(minute) || (minute as number) < 0 || (minute as number) > 59) return false;
  if (days !== undefined && (!Array.isArray(days) || days.some((day) => !DAYS.includes(day)))) return false;
  return typeof timezone === "string" && isTimezone(timezone);
}

const PARTS = new Map<string, Intl.DateTimeFormat>();

function formatter(timezone: string): Intl.DateTimeFormat {
  let found = PARTS.get(timezone);
  if (found === undefined) {
    found = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    PARTS.set(timezone, found);
  }
  return found;
}

interface Wall {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

/** The wall clock in `timezone` at an instant. */
export function wallClock(at: Date, timezone: string): Wall {
  const parts = formatter(timezone).formatToParts(at);
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  return { year: read("year"), month: read("month"), day: read("day"), hour: read("hour"), minute: read("minute"), second: read("second") };
}

/** How far `timezone` is from UTC at an instant, in milliseconds. */
function offsetAt(at: Date, timezone: string): number {
  const wall = wallClock(at, timezone);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  return asUtc - at.getTime();
}

/**
 * The instant a wall-clock time in `timezone` happens.
 *
 * Twice a year the offset at the answer is not the offset at the guess, so the
 * guess is corrected once and checked. A time that does not exist locally (the
 * hour a spring-forward skips) lands on the instant just after the jump, which
 * is what a person means by "9am" on a day with no 9am.
 */
export function instantOf(wall: Omit<Wall, "second">, timezone: string): Date {
  const naive = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
  const first = new Date(naive - offsetAt(new Date(naive), timezone));
  const corrected = new Date(naive - offsetAt(first, timezone));
  return corrected;
}

/**
 * When a schedule next fires, strictly after `from`.
 *
 * Walks forward a day at a time — at most a week and a bit, since a schedule
 * with days always has one within seven — rather than doing calendar
 * arithmetic that has to know about month lengths.
 */
export function nextRun(schedule: Schedule, from: Date): Date {
  const wanted = schedule.days === undefined || schedule.days.length === 0 ? null : new Set(schedule.days);
  const wall = wallClock(from, schedule.timezone);
  for (let ahead = 0; ahead <= 8; ahead += 1) {
    // Local midnight plus `ahead` days, then the scheduled time on that day.
    const midnight = Date.UTC(wall.year, wall.month - 1, wall.day + ahead);
    const day = new Date(midnight);
    const candidate = instantOf(
      {
        year: day.getUTCFullYear(),
        month: day.getUTCMonth() + 1,
        day: day.getUTCDate(),
        hour: schedule.hour,
        minute: schedule.minute,
      },
      schedule.timezone,
    );
    if (candidate.getTime() <= from.getTime()) continue;
    if (wanted !== null) {
      const local = wallClock(candidate, schedule.timezone);
      const weekday = new Date(Date.UTC(local.year, local.month - 1, local.day)).getUTCDay();
      if (!wanted.has(DAYS[weekday] as Day)) continue;
    }
    return candidate;
  }
  // Unreachable for any valid schedule; a day later beats an exception here.
  return new Date(from.getTime() + 24 * 60 * 60_000);
}

/** The timezone a clock routine uses when nobody named one. */
export const defaultTimezone = (): string => {
  const named = process.env.BOT_TIMEZONE?.trim();
  if (named !== undefined && named !== "" && isTimezone(named)) return named;
  try {
    return new Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

/** How a schedule reads in the console and in a brief. */
export function describeSchedule(schedule: Schedule): string {
  const time = `${String(schedule.hour).padStart(2, "0")}:${String(schedule.minute).padStart(2, "0")}`;
  const days =
    schedule.days === undefined || schedule.days.length === 0
      ? "every day"
      : schedule.days.length === 5 && DAYS.slice(1, 6).every((day) => schedule.days?.includes(day))
        ? "every weekday"
        : schedule.days.map((day) => day[0]?.toUpperCase() + day.slice(1)).join(", ");
  return `${days} at ${time} ${schedule.timezone}`;
}
