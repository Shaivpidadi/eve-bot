import { afterEach, describe, expect, it, vi } from "vitest";

import { forgetGatewayCatalog, FREE_FALLBACK, freeDefault, gatewayCatalog, sortCatalog, toCatalogModel } from "../agent/lib/gateway-models";

/** AI Gateway's model list, as the Models page reads it: only what a Bot can run on, free ones marked truly free. */

const entry = (over: Record<string, unknown>) => ({
  id: "acme/model",
  name: "Model",
  type: "language",
  tags: ["tool-use"],
  modalities: { input: ["text"], output: ["text"] },
  context_window: 128000,
  zdr: "none",
  pricing: { input: "0.000002", output: "0.00001" },
  ...over,
});

afterEach(() => {
  forgetGatewayCatalog();
  vi.useRealTimers();
});

describe("toCatalogModel", () => {
  it("keeps language models that call tools, with prices per million tokens", () => {
    expect(toCatalogModel(entry({}))).toEqual({
      id: "acme/model",
      name: "Model",
      provider: "acme",
      free: false,
      inputPerM: 2,
      priceVaries: false,
      outputPerM: 10,
      context: 128000,
      maxOutput: null,
      vision: false,
      structured: false,
      reasoning: false,
      zdr: "none",
    });
    expect(toCatalogModel(entry({ max_tokens: 524288 }))).toMatchObject({ maxOutput: 524288 });
    expect(toCatalogModel(entry({ type: "image" }))).toBeNull();
    expect(toCatalogModel(entry({ tags: ["reasoning"] }))).toBeNull();
    expect(toCatalogModel(entry({ id: "no slash" }))).toBeNull();
    expect(toCatalogModel(entry({ id: "acme/model-batch" }))).toBeNull();
  });

  it("calls a model free only when it costs nothing at every provider", () => {
    expect(toCatalogModel(entry({ pricing: { input: "0", output: "0" } }))?.free).toBe(true);
    expect(toCatalogModel(entry({ pricing: { input: "0", output: "0", varies_by_provider: true } }))).toMatchObject({ free: false, priceVaries: true });
    expect(toCatalogModel(entry({ pricing: { input: "0", output: "0.000001" } }))?.free).toBe(false);
  });

  it("reads vision from the tag or the input kinds, and structured output and reasoning from tags", () => {
    expect(toCatalogModel(entry({ modalities: { input: ["text", "image"] } }))?.vision).toBe(true);
    expect(toCatalogModel(entry({ tags: ["tool-use", "vision", "structured-output", "reasoning"] }))).toMatchObject({ vision: true, structured: true, reasoning: true });
  });
});

describe("ordering and the free default", () => {
  const models = [
    toCatalogModel(entry({ id: "acme/pricey", name: "Pricey", pricing: { input: "0.00001", output: "0.00005" } }))!,
    toCatalogModel(entry({ id: "acme/text-free", name: "Text free", pricing: { input: "0", output: "0" } }))!,
    toCatalogModel(entry({ id: "acme/cheap", name: "Cheap", pricing: { input: "0.0000001", output: "0.0000002" } }))!,
    toCatalogModel(entry({ id: "acme/eyes-free", name: "Eyes free", tags: ["tool-use", "vision", "structured-output"], pricing: { input: "0", output: "0" } }))!,
  ];

  it("puts free models first, then the cheapest", () => {
    expect(sortCatalog(models).map((model) => model.id)).toEqual(["acme/eyes-free", "acme/text-free", "acme/cheap", "acme/pricey"]);
  });

  it("prefers a free model that can see screenshots, and falls back when none is free", () => {
    expect(freeDefault({ models })).toBe("acme/eyes-free");
    expect(freeDefault({ models: models.filter((model) => model.id !== "acme/eyes-free") })).toBe("acme/text-free");
    expect(freeDefault({ models: [] })).toBe(FREE_FALLBACK);
  });
});

describe("gatewayCatalog", () => {
  it("keeps the last good list when Gateway stops answering", async () => {
    vi.useFakeTimers();
    const good = async () => new Response(JSON.stringify({ data: [entry({ id: "acme/one" })] }));
    expect((await gatewayCatalog(good as typeof fetch)).models.map((model) => model.id)).toEqual(["acme/one"]);
    vi.setSystemTime(Date.now() + 11 * 60_000);
    const down = async () => new Response("no", { status: 503 });
    const after = await gatewayCatalog(down as typeof fetch);
    expect(after.models.map((model) => model.id)).toEqual(["acme/one"]);
    expect(after.error).toMatch(/503/);
  });

  it("says why when it never could read the list", async () => {
    const down = async () => {
      throw new Error("offline");
    };
    expect(await gatewayCatalog(down as typeof fetch)).toEqual({ models: [], at: null, error: "offline" });
  });
});
