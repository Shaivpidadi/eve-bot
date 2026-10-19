import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CatalogModel } from "../agent/lib/gateway-models";

/**
 * Models chosen in the console: a setting wins over the deployment's defaults,
 * "Free models only" puts every role on a free model, and a choice Gateway
 * would refuse is never saved.
 */

const model = (id: string, over: Partial<CatalogModel> = {}): CatalogModel => ({
  id,
  name: id,
  provider: id.split("/")[0]!,
  free: false,
  inputPerM: 1,
  priceVaries: false,
  outputPerM: 5,
  context: 200000,
  vision: true,
  structured: true,
  reasoning: true,
  zdr: "all",
  ...over,
});
const catalog = {
  models: [
    model("free/eyes", { free: true, inputPerM: 0, outputPerM: 0, zdr: "none" }),
    model("free/text", { free: true, inputPerM: 0, outputPerM: 0, vision: false, zdr: "none" }),
    model("paid/smart"),
    model("paid/noretention", { zdr: "none" }),
  ],
};

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv("BOT_STORE", "memory");
  vi.stubEnv("BOT_MODEL_BASE_URL", "");
  vi.stubEnv("BOT_HQ_MODEL", "");
  vi.stubEnv("BOT_TEAMMATE_MODEL", "");
});

const load = () => import("../agent/lib/model-settings");

describe("resolving a role's model", () => {
  it("is the deployment's default until someone picks one", async () => {
    const { resolveModel } = await load();
    expect(await resolveModel("ws", "hq")).toMatchObject({ id: "anthropic/claude-sonnet-5", source: "default" });
    vi.stubEnv("BOT_HQ_MODEL", "acme/env-pick");
    expect(await resolveModel("ws", "hq")).toMatchObject({ id: "acme/env-pick", source: "default" });
  });

  it("prefers the saved choice, per workspace, with what the list said about it", async () => {
    const { resolveModel, saveModelSettings } = await load();
    expect((await saveModelSettings("ws", { roles: { hq: "paid/smart", quick: "free/text" } }, "op", catalog)).ok).toBe(true);
    expect(await resolveModel("ws", "hq")).toEqual({ id: "paid/smart", context: 200000, reasoning: true, free: false, source: "setting" });
    expect(await resolveModel("ws", "quick")).toMatchObject({ id: "free/text", free: true });
    expect(await resolveModel("other", "hq")).toMatchObject({ source: "default" });
  });

  it("puts every role on a free model while free-only is on, keeping roles already free", async () => {
    const { resolveModel, saveModelSettings } = await load();
    await saveModelSettings("ws", { roles: { quick: "free/text" } }, "op", catalog);
    expect((await saveModelSettings("ws", { freeOnly: true }, "op", catalog)).ok).toBe(true);
    expect(await resolveModel("ws", "quick")).toMatchObject({ id: "free/text", source: "setting" });
    expect(await resolveModel("ws", "hq")).toMatchObject({ id: "free/eyes", source: "free", free: true });
    expect(await resolveModel("ws", "deep")).toMatchObject({ id: "free/eyes" });
    await saveModelSettings("ws", { freeOnly: false }, "op", catalog);
    expect(await resolveModel("ws", "hq")).toMatchObject({ source: "default" });
  });

  it("never applies saved Gateway models to a custom endpoint", async () => {
    const { resolveModel, saveModelSettings } = await load();
    await saveModelSettings("ws", { roles: { hq: "paid/smart" } }, "op", catalog);
    vi.stubEnv("BOT_MODEL_BASE_URL", "http://localhost:11434/v1");
    vi.stubEnv("BOT_MODEL", "llama3");
    expect((await resolveModel("ws", "hq")).source).toBe("default");
  });
});

describe("saving", () => {
  it("takes a model Gateway doesn't list yet, and goes back to the default on null", async () => {
    const { readModelSettings, saveModelSettings } = await load();
    const saved = await saveModelSettings("ws", { roles: { standard: "newco/just-launched" } }, "op", catalog);
    expect(saved.ok && saved.settings.roles.standard).toMatchObject({ id: "newco/just-launched", listed: false, vision: null });
    await saveModelSettings("ws", { roles: { standard: null } }, "op", catalog);
    expect((await readModelSettings("ws")).roles.standard).toBeUndefined();
  });

  it("refuses what is not a model id", async () => {
    const { saveModelSettings } = await load();
    for (const bad of ["claude", "a/b c", "../../etc/passwd", `x/${"y".repeat(130)}`]) {
      expect((await saveModelSettings("ws", { roles: { hq: bad } }, "op", catalog)).ok).toBe(false);
    }
  });

  it("refuses a paid or unlisted model while free-only is on", async () => {
    const { saveModelSettings } = await load();
    await saveModelSettings("ws", { freeOnly: true }, "op", catalog);
    expect(await saveModelSettings("ws", { roles: { hq: "paid/smart" } }, "op", catalog)).toMatchObject({ ok: false, error: expect.stringContaining("not free") });
    expect(await saveModelSettings("ws", { roles: { hq: "newco/unknown" } }, "op", catalog)).toMatchObject({ ok: false, error: expect.stringContaining("not in AI Gateway") });
  });

  it("refuses free-only, or a model with no retention guarantee, when the deployment asks for Zero Data Retention", async () => {
    vi.stubEnv("BOT_ZDR", "1");
    const { saveModelSettings } = await load();
    expect((await saveModelSettings("ws", { freeOnly: true }, "op", catalog)).ok).toBe(false);
    expect(await saveModelSettings("ws", { roles: { hq: "paid/noretention" } }, "op", catalog)).toMatchObject({ ok: false, error: expect.stringContaining("Zero Data Retention") });
    expect((await saveModelSettings("ws", { roles: { hq: "paid/smart" } }, "op", catalog)).ok).toBe(true);
  });

  it("is refused when the deployment locks models", async () => {
    vi.stubEnv("BOT_MODELS_EDITABLE", "off");
    const { saveModelSettings } = await load();
    expect((await saveModelSettings("ws", { roles: { hq: "paid/smart" } }, "op", catalog)).ok).toBe(false);
  });
});
