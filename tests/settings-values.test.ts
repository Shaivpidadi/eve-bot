import { describe, expect, it } from "vitest";

import { normalizeValue, SETTINGS_BY_ENV } from "../agent/lib/settings/registry";

/**
 * A setting saved in the console is refused when it cannot work, rather than
 * saved and failing later: a timezone no one knows, a cron line with a typo,
 * an address that is not one.
 */

const check = (env: string, value: string) => normalizeValue(SETTINGS_BY_ENV.get(env)!, value);

describe("a text setting's value", () => {
  it("is a timezone the server knows", () => {
    expect(check("BOT_TIMEZONE", "America/Chicago")).toEqual({ ok: true, value: "America/Chicago" });
    expect(check("BOT_TIMEZONE", "Mars/Olympus")).toMatchObject({ ok: false, error: expect.stringContaining("not a timezone") });
  });

  it("is a cron line of five fields", () => {
    expect(check("BOT_TICK_CRON", "* * * * *")).toMatchObject({ ok: true });
    expect(check("BOT_STANDUP_CRON", "0 13 * * 1-5")).toMatchObject({ ok: true });
    expect(check("BOT_TICK_CRON", "every minute")).toMatchObject({ ok: false });
    expect(check("BOT_TICK_CRON", "* * * *")).toMatchObject({ ok: false });
  });

  it("is an http or https address where it names one", () => {
    expect(check("BOT_SEARCH_URL", "http://localhost:8888")).toMatchObject({ ok: true });
    expect(check("BOT_MODEL_BASE_URL", "172.16.10.121:11434/v1")).toMatchObject({ ok: false, error: expect.stringContaining("http") });
    expect(check("BOT_EMAIL_WEBHOOK", "ftp://example.com/hook")).toMatchObject({ ok: false });
  });
});
