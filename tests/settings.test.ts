import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Settings saved in the console: a saved value wins over the environment's,
 * which stays the default; deployment settings are the owner's; a tenant's
 * budget stays under the deployment's; secrets are sealed and never shown.
 */

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv("BOT_STORE", "memory");
  vi.stubEnv("BOT_COMPUTER_KEY", "k".repeat(40));
  for (const name of ["BOT_BUDGET_MONTHLY_USD", "BOT_BROWSER_PAGE_CHARS", "BOT_WORKER", "BOT_SETTINGS_EDITABLE", "BOT_EMAIL_WEBHOOK_TOKEN", "BOT_JEV"]) vi.stubEnv(name, "");
});

const owner = { workspaceId: "default", owner: true, by: "owner" };
const tenant = { workspaceId: "acme", owner: false, by: "ann" };
const load = () => import("../agent/lib/settings/store");

describe("effectiveEnv", () => {
  it("lays saved values over the environment, which stays the default", async () => {
    vi.stubEnv("BOT_BROWSER_PAGE_CHARS", "8000");
    const { effectiveEnv, saveSettings } = await load();
    expect((await effectiveEnv()).BOT_BROWSER_PAGE_CHARS).toBe("8000");
    expect(await saveSettings(owner, { BOT_BROWSER_PAGE_CHARS: 12000 })).toEqual({ ok: true });
    expect((await effectiveEnv()).BOT_BROWSER_PAGE_CHARS).toBe("12000");
    await saveSettings(owner, { BOT_BROWSER_PAGE_CHARS: null });
    expect((await effectiveEnv()).BOT_BROWSER_PAGE_CHARS).toBe("8000");
  });

  it("keeps a workspace's own settings to that workspace", async () => {
    const { effectiveEnv, saveSettings } = await load();
    await saveSettings(tenant, { BOT_TIMEZONE: "Europe/Berlin" });
    expect((await effectiveEnv("acme")).BOT_TIMEZONE).toBe("Europe/Berlin");
    expect((await effectiveEnv("other")).BOT_TIMEZONE).not.toBe("Europe/Berlin");
  });

  it("lets a saved setting only pause the background worker, never turn it on", async () => {
    const { effectiveEnv, saveSettings } = await load();
    await saveSettings(owner, { BOT_WORKER: true });
    expect((await effectiveEnv()).BOT_WORKER).toBe("");
    await saveSettings(owner, { BOT_WORKER: false });
    vi.stubEnv("BOT_WORKER", "on");
    expect((await effectiveEnv()).BOT_WORKER).toBe("off");
  });
});

describe("saveSettings", () => {
  it("keeps deployment settings to the owner", async () => {
    const { saveSettings } = await load();
    expect(await saveSettings(tenant, { BOT_BROWSER_PAGE_CHARS: 12000 })).toMatchObject({ ok: false, status: 403 });
    expect(await saveSettings(tenant, { BOT_TIMEZONE: "Asia/Tokyo" })).toEqual({ ok: true });
  });

  it("lets a tenant only lower the deployment's budget", async () => {
    vi.stubEnv("BOT_BUDGET_MONTHLY_USD", "100");
    const { effectiveEnv, saveSettings } = await load();
    expect(await saveSettings(tenant, { BOT_BUDGET_MONTHLY_USD: 500 })).toMatchObject({ ok: false, status: 403, error: expect.stringContaining("$100") });
    expect(await saveSettings(tenant, { BOT_BUDGET_MONTHLY_USD: 40 })).toEqual({ ok: true });
    expect((await effectiveEnv("acme")).BOT_BUDGET_MONTHLY_USD).toBe("40");
    // The owner sets the workspace's own as they like.
    expect(await saveSettings(owner, { BOT_BUDGET_MONTHLY_USD: 500 })).toEqual({ ok: true });
  });

  it("checks each value against its setting before writing anything", async () => {
    const { effectiveEnv, saveSettings } = await load();
    expect(await saveSettings(owner, { BOT_BROWSER_PAGE_CHARS: 10, BOT_JEV: false })).toMatchObject({ ok: false, status: 400, error: expect.stringContaining("at least") });
    expect((await effectiveEnv()).BOT_JEV).toBe("");
    expect(await saveSettings(owner, { BOT_NOT_A_THING: "x" })).toMatchObject({ ok: false, status: 400 });
    expect(await saveSettings(owner, { BOT_STORE: "fs" })).toMatchObject({ ok: false, status: 400 });
    expect(await saveSettings(owner, { BOT_HQ_MODEL: "a/b" })).toMatchObject({ ok: false, error: expect.stringContaining("Models page") });
    expect(await saveSettings(owner, { BOT_SANDBOX_ALLOW_DOMAINS: "github.com, *.npmjs.org" })).toEqual({ ok: true });
    expect((await effectiveEnv()).BOT_SANDBOX_ALLOW_DOMAINS).toBe("github.com,*.npmjs.org");
  });

  it("seals secrets, hands them to readers, and never shows them", async () => {
    const { effectiveEnv, saveSettings, settingsReport } = await load();
    await saveSettings(owner, { BOT_EMAIL_WEBHOOK_TOKEN: "s3cret-token" });
    expect((await effectiveEnv()).BOT_EMAIL_WEBHOOK_TOKEN).toBe("s3cret-token");
    const { store } = await import("../agent/lib/store");
    expect(JSON.stringify(await store().get("settings/_deployment.json"))).not.toContain("s3cret-token");
    const report = await settingsReport(owner);
    expect(report.settings.find((setting) => setting.env === "BOT_EMAIL_WEBHOOK_TOKEN")).toMatchObject({ value: null, isSet: true, source: "setting" });
  });

  it("is refused everywhere when the deployment locks settings", async () => {
    vi.stubEnv("BOT_SETTINGS_EDITABLE", "off");
    const { saveSettings } = await load();
    expect(await saveSettings(owner, { BOT_TIMEZONE: "UTC" })).toMatchObject({ ok: false, status: 403 });
  });
});

describe("settingsReport", () => {
  it("shows a tenant only its workspace's settings, and never sensitive ones", async () => {
    const { settingsReport } = await load();
    const seen = (await settingsReport(tenant)).settings;
    expect(seen.every((setting) => setting.scope === "workspace")).toBe(true);
    expect(seen.map((setting) => setting.env)).toContain("BOT_BUDGET_MONTHLY_USD");
    expect(seen.map((setting) => setting.env)).not.toContain("BOT_EMAIL_WEBHOOK");
    const all = (await settingsReport(owner)).settings;
    expect(all.map((setting) => setting.env)).toContain("BOT_EMAIL_WEBHOOK");
    // Models are edited on their own page.
    expect(all.map((setting) => setting.env)).not.toContain("BOT_HQ_MODEL");
  });

  it("says where each value comes from, and when a saved one hides the environment's", async () => {
    vi.stubEnv("BOT_BROWSER_PAGE_CHARS", "8000");
    const { saveSettings, settingsReport } = await load();
    const before = (await settingsReport(owner)).settings.find((setting) => setting.env === "BOT_BROWSER_PAGE_CHARS");
    expect(before).toMatchObject({ value: "8000", source: "env", overridesEnv: false });
    await saveSettings(owner, { BOT_BROWSER_PAGE_CHARS: 9000 });
    const after = (await settingsReport(owner)).settings.find((setting) => setting.env === "BOT_BROWSER_PAGE_CHARS");
    expect(after).toMatchObject({ value: "9000", source: "setting", overridesEnv: true });
  });
});

describe("exports", () => {
  it("count saved settings as secret, so an export without secrets leaves them out", async () => {
    const { isSecretKey, inWorkspace } = await import("../agent/lib/store/transfer");
    expect(isSecretKey("settings/_deployment.json")).toBe(true);
    expect(isSecretKey("settings/acme/settings.json")).toBe(true);
    expect(isSecretKey("settings/acme/operator.json")).toBe(false);
    // No workspace can claim the deployment's settings.
    expect(inWorkspace("settings/_deployment.json", "deployment")).toBe(false);
  });
});

describe("readers use what Settings say", () => {
  it("caps a workspace's spend with the budget set in Settings over the environment's", async () => {
    vi.stubEnv("BOT_BUDGET_MONTHLY_USD", "100");
    const { saveSettings } = await load();
    const { admitRun, workspaceLimits } = await import("../agent/lib/budget");
    expect(await workspaceLimits("acme")).toMatchObject({ monthlyUsd: 100 });
    await saveSettings(tenant, { BOT_BUDGET_MONTHLY_USD: 1 });
    expect(await workspaceLimits("acme")).toMatchObject({ monthlyUsd: 1 });
    const refused = await admitRun("acme", "run_1", 2);
    expect(refused).toMatchObject({ ok: false, reason: expect.stringContaining("monthly budget in Settings") });
    expect(await admitRun("other", "run_2", 2)).toMatchObject({ ok: true });
  });
});

describe("the browser uses what Settings say", () => {
  it("reads its page size, settle, guard and pilot from Settings over the environment", async () => {
    vi.stubEnv("BOT_BROWSER_PAGE_CHARS", "8000");
    const { effectiveEnv, saveSettings } = await load();
    const { pageBudget } = await import("../agent/subagents/teammate/lib/page");
    const { guardGraceMs } = await import("../agent/lib/computer/netguard");
    expect(pageBudget(await effectiveEnv())).toBe(8000);
    await saveSettings(owner, { BOT_BROWSER_PAGE_CHARS: 16000, BOT_BROWSER_GUARD_MS: 2500 });
    expect(pageBudget(await effectiveEnv())).toBe(16000);
    expect(guardGraceMs(await effectiveEnv())).toBe(2500);
  });
});

describe("the team computer uses what Settings say", () => {
  it("reads its screens and live-link lifetime from Settings over the environment, within their limits", async () => {
    vi.stubEnv("BOT_COMPUTER_MAX_SCREENS", "2");
    const { effectiveEnv, saveSettings } = await load();
    const { maxScreens } = await import("../agent/lib/computer/screens");
    const { tokenTtlSeconds } = await import("../agent/lib/computer/tokens");
    expect(maxScreens(await effectiveEnv())).toBe(2);
    await saveSettings(owner, { BOT_COMPUTER_MAX_SCREENS: 6, BOT_COMPUTER_TOKEN_TTL_SECONDS: 90 });
    expect(maxScreens(await effectiveEnv())).toBe(6);
    expect(tokenTtlSeconds(await effectiveEnv())).toBe(90);
    expect(maxScreens({ BOT_COMPUTER_MAX_SCREENS: "40" })).toBe(9);
  });
});
