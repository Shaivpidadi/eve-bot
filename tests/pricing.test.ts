import { wrapLanguageModel } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

type WrappableModel = Parameters<typeof wrapLanguageModel>[0]["model"];

const usage = (input: number, output: number) => ({
  inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: output, text: output, reasoning: 0 },
  raw: {},
});

/** A model that answers instantly, so the middleware around it can be watched. */
function fakeModel(providerMetadata?: Record<string, Record<string, unknown>>): WrappableModel {
  return {
    specificationVersion: "v4",
    provider: "fake",
    modelId: "fake-1",
    supportedUrls: {},
    async doGenerate() {
      return { content: [], finishReason: "stop", usage: usage(1_000_000, 500_000), warnings: [], providerMetadata };
    },
    async doStream() {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "finish", finishReason: "stop", usage: usage(2_000_000, 1_000_000), providerMetadata });
          controller.close();
        },
      });
      return { stream };
    },
  } as unknown as WrappableModel;
}

async function collect(stream: ReadableStream<unknown>): Promise<unknown[]> {
  const parts: unknown[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return parts;
    parts.push(value);
  }
}

describe("parsePrices", () => {
  it("reads model=input/output in USD per million tokens, with a wildcard", async () => {
    const { parsePrices } = await import("../agent/lib/pricing");
    const prices = parsePrices("qwen3:8b=0/0, anthropic/claude-sonnet-4.5=3/15,*=1/2");
    expect(prices.get("qwen3:8b")).toEqual({ input: 0, output: 0 });
    expect(prices.get("anthropic/claude-sonnet-4.5")).toEqual({ input: 3, output: 15 });
    expect(prices.get("*")).toEqual({ input: 1, output: 2 });
  });

  it("ignores entries it cannot read and says so", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { parsePrices } = await import("../agent/lib/pricing");
    const prices = parsePrices("broken,x=abc/1,y=1,z=-1/2,ok=2/4");
    expect([...prices.keys()]).toEqual(["ok"]);
    expect(warn).toHaveBeenCalledTimes(3);
    expect(parsePrices(undefined).size).toBe(0);
  });
});

describe("costOf", () => {
  it("prices input and output tokens per million", async () => {
    const { costOf } = await import("../agent/lib/pricing");
    expect(costOf(usage(5388, 26), { input: 1, output: 2 })).toBeCloseTo(0.00544, 10);
    expect(costOf(usage(1_000_000, 1_000_000), { input: 3, output: 15 })).toBe(18);
    expect(costOf({ ...usage(0, 0), inputTokens: { ...usage(0, 0).inputTokens, total: undefined } }, { input: 3, output: 15 })).toBe(0);
  });
});

describe("priceFor", () => {
  beforeEach(() => vi.resetModules());

  it("prefers the configured price, then OpenRouter's list, then the wildcard", async () => {
    vi.stubEnv("BOT_MODEL_PRICES", "mine=1/1,*=9/9");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ data: [{ id: "openai/gpt-5", pricing: { prompt: "0.00000125", completion: "0.00001" } }, { id: "broken" }] }),
      ),
    );
    const { priceFor, isOpenRouter } = await import("../agent/lib/pricing");
    const openrouter = "https://openrouter.ai/api/v1";
    expect(isOpenRouter(openrouter)).toBe(true);
    expect(isOpenRouter("http://localhost:11434/v1")).toBe(false);
    expect(await priceFor(openrouter, "mine")).toEqual({ input: 1, output: 1 });
    const listed = await priceFor(openrouter, "openai/gpt-5");
    expect(listed?.input).toBeCloseTo(1.25, 10);
    expect(listed?.output).toBeCloseTo(10, 10);
    expect(await priceFor(openrouter, "unknown")).toEqual({ input: 9, output: 9 });
    // The list is read once, not once per step.
    await priceFor(openrouter, "openai/gpt-5");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("prices nothing for an unlisted model on a plain endpoint", async () => {
    vi.stubEnv("BOT_MODEL_PRICES", "");
    vi.stubGlobal("fetch", vi.fn());
    const { priceFor } = await import("../agent/lib/pricing");
    expect(await priceFor("http://localhost:11434/v1", "qwen3:8b")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("carries on without prices when OpenRouter's list cannot be read", async () => {
    vi.stubEnv("BOT_MODEL_PRICES", "");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { priceFor } = await import("../agent/lib/pricing");
    expect(await priceFor("https://openrouter.ai/api/v1", "openai/gpt-5")).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe("pricedModel", () => {
  beforeEach(() => vi.resetModules());

  it("writes the step's cost where eve reads AI Gateway's, on generate and on stream", async () => {
    vi.stubEnv("BOT_MODEL_PRICES", "fake-1=2/4");
    const { pricedModel } = await import("../agent/lib/pricing");
    const model = pricedModel(fakeModel({ custom: { id: "abc" } }), "http://localhost:11434/v1", "fake-1") as unknown as {
      doGenerate: (options: unknown) => Promise<{ providerMetadata?: Record<string, Record<string, unknown>> }>;
      doStream: (options: unknown) => Promise<{ stream: ReadableStream<unknown> }>;
    };
    const generated = await model.doGenerate({ prompt: [] });
    expect(generated.providerMetadata).toEqual({ custom: { id: "abc" }, gateway: { cost: 2 + 2 } });

    const parts = (await collect((await model.doStream({ prompt: [] })).stream)) as Array<{ type: string; providerMetadata?: unknown }>;
    const finish = parts.find((part) => part.type === "finish");
    expect(finish?.providerMetadata).toEqual({ custom: { id: "abc" }, gateway: { cost: 4 + 4 } });
  });

  it("leaves an unpriced model's steps untouched", async () => {
    vi.stubEnv("BOT_MODEL_PRICES", "");
    const { pricedModel } = await import("../agent/lib/pricing");
    const model = pricedModel(fakeModel(), "http://localhost:11434/v1", "fake-1") as unknown as {
      doGenerate: (options: unknown) => Promise<{ providerMetadata?: unknown }>;
    };
    expect((await model.doGenerate({ prompt: [] })).providerMetadata).toBeUndefined();
  });
});
