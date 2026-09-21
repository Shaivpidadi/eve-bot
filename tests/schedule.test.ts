import { describe, expect, it } from "vitest";

import { describeSchedule, isSchedule, nextRun, wallClock } from "../agent/lib/schedule";

const NY = "America/New_York";
const local = (at: Date, timezone = NY) => {
  const wall = wallClock(at, timezone);
  return `${wall.year}-${String(wall.month).padStart(2, "0")}-${String(wall.day).padStart(2, "0")} ${String(wall.hour).padStart(2, "0")}:${String(wall.minute).padStart(2, "0")}`;
};

describe("nextRun", () => {
  it("fires at the same wall-clock time every day, whatever the run took", () => {
    const schedule = { hour: 9, minute: 0, timezone: NY };
    // A cycle that finished at 09:06 must not push tomorrow's run to 09:06.
    const after = nextRun(schedule, new Date("2026-03-10T13:06:00Z"));
    expect(local(after)).toBe("2026-03-11 09:00");
  });

  it("skips the days it was not asked for", () => {
    const weekdays = { hour: 9, minute: 0, days: ["mon", "tue", "wed", "thu", "fri"] as const, timezone: NY };
    // Friday 10:00 local → Monday, not Saturday.
    const next = nextRun(weekdays, new Date("2026-09-18T14:00:00Z"));
    expect(local(next)).toBe("2026-09-21 09:00");
    expect(new Date(next).getUTCDay()).toBe(1);
  });

  it("keeps the local hour across a spring-forward", () => {
    const schedule = { hour: 9, minute: 0, timezone: NY };
    // US clocks jump on 8 March 2026; 09:00 local is 14:00 UTC before and 13:00 after.
    const before = nextRun(schedule, new Date("2026-03-06T15:00:00Z"));
    expect(local(before)).toBe("2026-03-07 09:00");
    expect(before.toISOString()).toBe("2026-03-07T14:00:00.000Z");
    const after = nextRun(schedule, new Date("2026-03-08T15:00:00Z"));
    expect(local(after)).toBe("2026-03-09 09:00");
    expect(after.toISOString()).toBe("2026-03-09T13:00:00.000Z");
  });

  it("keeps the local hour across an autumn fall-back", () => {
    const schedule = { hour: 9, minute: 30, timezone: NY };
    // From Saturday afternoon, over the night the clocks go back: 09:30 local
    // is 13:30 UTC before the change and 14:30 UTC after it.
    const before = nextRun(schedule, new Date("2026-10-30T20:00:00Z"));
    expect(before.toISOString()).toBe("2026-10-31T13:30:00.000Z");
    const after = nextRun(schedule, new Date("2026-10-31T20:00:00Z"));
    expect(local(after)).toBe("2026-11-01 09:30");
    expect(after.toISOString()).toBe("2026-11-01T14:30:00.000Z");
  });

  it("always moves forward, never returns the instant it was given", () => {
    const schedule = { hour: 9, minute: 0, timezone: NY };
    const at9 = new Date("2026-09-21T13:00:00Z");
    expect(nextRun(schedule, at9).getTime()).toBeGreaterThan(at9.getTime());
  });

  it("works in a timezone on the other side of the date line", () => {
    const schedule = { hour: 8, minute: 15, timezone: "Pacific/Auckland" };
    // Midnight UTC is already midday in Auckland, so 08:15 today has gone.
    const next = nextRun(schedule, new Date("2026-09-20T00:00:00Z"));
    expect(local(next, "Pacific/Auckland")).toBe("2026-09-21 08:15");
  });
});

describe("isSchedule", () => {
  it("accepts a real one and refuses nonsense", () => {
    expect(isSchedule({ hour: 9, minute: 0, timezone: NY })).toBe(true);
    expect(isSchedule({ hour: 9, minute: 0, days: ["mon"], timezone: NY })).toBe(true);
    expect(isSchedule({ hour: 24, minute: 0, timezone: NY })).toBe(false);
    expect(isSchedule({ hour: 9, minute: 0, timezone: "Mars/Olympus" })).toBe(false);
    expect(isSchedule({ hour: 9, minute: 0, days: ["funday"], timezone: NY })).toBe(false);
  });
});

describe("describeSchedule", () => {
  it("reads the way someone would say it", () => {
    expect(describeSchedule({ hour: 9, minute: 0, timezone: NY })).toBe("every day at 09:00 America/New_York");
    expect(describeSchedule({ hour: 17, minute: 30, days: ["mon", "tue", "wed", "thu", "fri"], timezone: NY })).toBe(
      "every weekday at 17:30 America/New_York",
    );
  });
});
