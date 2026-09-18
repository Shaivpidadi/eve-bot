import { beforeEach, describe, expect, it, vi } from "vitest";

/** When Bot's small decisions go to Jev, and when it goes without. */
describe("jevOn", () => {
  beforeEach(() => {
    vi.resetModules();
    for (const name of ["BOT_JEV", "BOT_MODEL_BASE_URL", "AI_GATEWAY_API_KEY", "VERCEL_OIDC_TOKEN", "VERCEL"]) vi.stubEnv(name, "");
  });

  it("is on by default with Gateway models, and off with the one switch", async () => {
    let { jevOn } = await import("../agent/lib/jev");
    expect(jevOn()).toBe(true);
    vi.resetModules();
    vi.stubEnv("BOT_JEV", "Off");
    ({ jevOn } = await import("../agent/lib/jev"));
    expect(jevOn()).toBe(false);
  });

  it("runs on a custom model endpoint only while Gateway can be reached", async () => {
    vi.stubEnv("BOT_MODEL_BASE_URL", "http://localhost:11434/v1");
    let { jevOn } = await import("../agent/lib/jev");
    expect(jevOn()).toBe(false);
    vi.resetModules();
    vi.stubEnv("AI_GATEWAY_API_KEY", " vck_key ");
    ({ jevOn } = await import("../agent/lib/jev"));
    expect(jevOn()).toBe(true);
    vi.resetModules();
    vi.stubEnv("AI_GATEWAY_API_KEY", "");
    vi.stubEnv("VERCEL", "1");
    ({ jevOn } = await import("../agent/lib/jev"));
    expect(jevOn()).toBe(true);
    vi.resetModules();
    vi.stubEnv("BOT_JEV", "off");
    ({ jevOn } = await import("../agent/lib/jev"));
    expect(jevOn()).toBe(false);
  });
});
