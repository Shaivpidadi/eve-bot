import { beforeEach, describe, expect, it, vi } from "vitest";

/** Which model a job runs on, and what a session may spend, from the environment. */
describe("models", () => {
  beforeEach(() => {
    vi.resetModules();
    for (const name of [
      "BOT_MODEL_BASE_URL", "BOT_MODEL", "BOT_MODEL_API_KEY", "BOT_MODEL_CONTEXT_TOKENS", "BOT_TEAMMATE_MODEL",
      "BOT_MODEL_QUICK", "BOT_MODEL_STANDARD", "BOT_MODEL_DEEP", "BOT_HQ_MODEL",
      "BOT_HQ_INPUT_TOKEN_LIMIT", "BOT_HQ_OUTPUT_TOKEN_LIMIT", "BOT_JOB_INPUT_TOKEN_LIMIT", "BOT_JOB_OUTPUT_TOKEN_LIMIT",
    ]) vi.stubEnv(name, "");
  });

  it("reads a job's effort off its brief and steps up after a failure", async () => {
    const { effortInBrief, nextEffort } = await import("../agent/lib/models");
    expect(effortInBrief("title: x\neffort: quick\n")).toBe("quick");
    expect(effortInBrief("effort: deep")).toBe("deep");
    expect(effortInBrief("effort: extreme")).toBe("standard");
    expect(effortInBrief("")).toBe("standard");
    expect(nextEffort("quick")).toBe("standard");
    expect(nextEffort("standard")).toBe("deep");
    expect(nextEffort("deep")).toBe("deep");
  });

  it("uses Gateway defaults per effort, with overrides per level or for every job", async () => {
    const { modelForEffort } = await import("../agent/lib/models");
    expect(modelForEffort("quick")).toBe("alibaba/qwen3.8-flash");
    expect(modelForEffort("deep")).toBe("anthropic/claude-opus-5");
    vi.stubEnv("BOT_MODEL_DEEP", "anthropic/claude-opus-5-1");
    expect(modelForEffort("deep")).toBe("anthropic/claude-opus-5-1");
    vi.stubEnv("BOT_TEAMMATE_MODEL", "one/model");
    expect(modelForEffort("quick")).toBe("one/model");
  });

  it("sends every level to BOT_MODEL on a custom endpoint, and insists on one", async () => {
    vi.stubEnv("BOT_MODEL_BASE_URL", "http://localhost:11434/v1/");
    const { customEndpoint, modelForEffort } = await import("../agent/lib/models");
    expect(customEndpoint()).toEqual({ baseURL: "http://localhost:11434/v1", apiKey: undefined, contextWindowTokens: 128_000 });
    expect(() => modelForEffort("standard")).toThrow(/set BOT_MODEL/);
    vi.stubEnv("BOT_MODEL", "qwen3:8b");
    vi.stubEnv("BOT_MODEL_CONTEXT_TOKENS", "32000");
    vi.stubEnv("BOT_MODEL_API_KEY", " key ");
    expect(modelForEffort("standard")).toBe("qwen3:8b");
    expect(modelForEffort("deep")).toBe("qwen3:8b");
    expect(customEndpoint()).toEqual({ baseURL: "http://localhost:11434/v1", apiKey: "key", contextWindowTokens: 32_000 });
  });

  it("passes reasoning to Gateway models, and to a custom endpoint only when asked", async () => {
    const gateway = await import("../agent/lib/models");
    expect(gateway.reasoningFor(undefined, "low")).toEqual({ reasoning: "low" });
    expect(gateway.reasoningFor("xhigh", "low")).toEqual({ reasoning: "xhigh" });
    expect(gateway.reasoningFor("silly", "low")).toEqual({ reasoning: "low" });
    vi.resetModules();
    vi.stubEnv("BOT_MODEL_BASE_URL", "http://localhost:11434/v1");
    const custom = await import("../agent/lib/models");
    expect(custom.reasoningFor(undefined, "medium")).toEqual({});
    expect(custom.reasoningFor("high", "medium")).toEqual({ reasoning: "high" });
  });

  it("caps tokens per session on a custom endpoint, with defaults, overrides, and off; eve's input default on Gateway", async () => {
    const gateway = await import("../agent/lib/models");
    expect(gateway.tokenLimits("hq")).toEqual({ input: 40_000_000, output: false });
    vi.resetModules();
    vi.stubEnv("BOT_MODEL_BASE_URL", "http://localhost:11434/v1");
    vi.stubEnv("BOT_JOB_OUTPUT_TOKEN_LIMIT", "250000");
    vi.stubEnv("BOT_HQ_INPUT_TOKEN_LIMIT", "off");
    vi.stubEnv("BOT_HQ_OUTPUT_TOKEN_LIMIT", "not-a-number");
    const custom = await import("../agent/lib/models");
    expect(custom.tokenLimits("job")).toEqual({ input: 10_000_000, output: 250_000 });
    expect(custom.tokenLimits("hq")).toEqual({ input: false, output: 2_000_000 });
  });

  it("stops a session's window at its spend, or at its token caps, counting only new input", async () => {
    const window = (over: Partial<{ inputTokens: number; cacheReadTokens: number; outputTokens: number; costUsd: number }>) => ({
      window: { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, ...over },
    });
    const gateway = await import("../agent/lib/models");
    const job = gateway.sessionUsage("job", 5);
    expect(job(window({ costUsd: 4.99 }))).toBe(false);
    expect(job(window({ costUsd: 5 }))).toBe(true);
    // Cache reads are the session replaying itself, not new input.
    expect(job(window({ inputTokens: 45_000_000, cacheReadTokens: 30_000_000 }))).toBe(false);
    expect(job(window({ inputTokens: 45_000_000, cacheReadTokens: 1_000_000 }))).toBe(true);
    // A cap that is no number leaves only the token caps.
    expect(gateway.sessionUsage("hq", Number.NaN)(window({ costUsd: 1_000 }))).toBe(false);
    vi.resetModules();
    vi.stubEnv("BOT_MODEL_BASE_URL", "http://localhost:11434/v1");
    const custom = await import("../agent/lib/models");
    // An unpriced local model reports no cost: its output cap is what stops it.
    expect(custom.sessionUsage("job", 5)(window({ outputTokens: 500_000 }))).toBe(true);
    expect(custom.sessionUsage("job", 5)(window({ outputTokens: 499_999 }))).toBe(false);
  });
});

describe("AI Gateway data controls", () => {
  it("asks for nothing unless a control is set, and never on a custom endpoint", async () => {
    const { gatewayOptions } = await import("../agent/lib/models");
    expect(gatewayOptions({})).toBeNull();
    expect(gatewayOptions({ BOT_ZDR: "0", BOT_INFERENCE_REGION: "" })).toBeNull();
    expect(gatewayOptions({ BOT_ZDR: "1", BOT_MODEL_BASE_URL: "http://localhost:11434/v1" })).toBeNull();
  });

  it("asks for Zero Data Retention and a region in Gateway's own shape", async () => {
    const { gatewayOptions } = await import("../agent/lib/models");
    expect(gatewayOptions({ BOT_ZDR: "1" })).toEqual({ gateway: { zeroDataRetention: true } });
    expect(gatewayOptions({ BOT_INFERENCE_REGION: "US" })).toEqual({ gateway: { inferenceRegion: { scope: "zone", geoRegion: "us" } } });
    expect(gatewayOptions({ BOT_ZDR: "true", BOT_INFERENCE_REGION: "us" })).toEqual({
      gateway: { zeroDataRetention: true, inferenceRegion: { scope: "zone", geoRegion: "us" } },
    });
    // Not a region name: left out rather than sent.
    expect(gatewayOptions({ BOT_INFERENCE_REGION: "us; drop" })).toBeNull();
  });

  it("merges into a call's own provider options and sits next to eve's model", async () => {
    vi.stubEnv("BOT_ZDR", "1");
    vi.stubEnv("BOT_MODEL_BASE_URL", "");
    const { gatewayModelOptions, withGatewayOptions } = await import("../agent/lib/models");
    expect(withGatewayOptions({ openai: { dimensions: 512 } })).toEqual({ openai: { dimensions: 512 }, gateway: { zeroDataRetention: true } });
    expect(gatewayModelOptions()).toEqual({ modelOptions: { providerOptions: { gateway: { zeroDataRetention: true } } } });
    vi.unstubAllEnvs();
  });
});

describe("explainGatewayError", () => {
  it("says plainly when a Gateway budget ran out, or no provider fits the data controls", async () => {
    const { explainGatewayError } = await import("../agent/lib/models");
    expect(explainGatewayError('402 {"error":{"message":"Budget exceeded","type":"quota_for_entity_exceeded"}}')).toMatchObject({ kind: "budget" });
    const none = explainGatewayError("400 no_providers_available", { BOT_ZDR: "1", BOT_INFERENCE_REGION: "us" });
    expect(none).toMatchObject({ kind: "no-providers" });
    expect(none?.text).toContain("Zero Data Retention (BOT_ZDR) and inference in US (BOT_INFERENCE_REGION)");
    expect(explainGatewayError("400 no_providers_available", {})?.text).toContain("right now");
    // As Gateway actually answers ZDR with no compliant provider (seen live).
    const live = explainGatewayError("No ZDR (Zero Data Retention) providers or ZDR-attested BYOK credentials available for model: nvidia/nemotron-3.5-lightning-free. Providers considered: nvidia", { BOT_ZDR: "1" });
    expect(live?.kind).toBe("no-providers");
    expect(live?.text).toContain("nvidia/nemotron-3.5-lightning-free with Zero Data Retention (BOT_ZDR)");
    const region = explainGatewayError("No provider for nvidia/nemotron-3.5-lightning-free supports the requested inference region. Providers considered: nvidia (scope=zone, geoRegion=us).", { BOT_INFERENCE_REGION: "us" });
    expect(region?.kind).toBe("no-providers");
    expect(region?.text).toContain("nvidia/nemotron-3.5-lightning-free with inference in US (BOT_INFERENCE_REGION)");
    // A text-only model handed a screenshot (seen live from stealth/cat-jam in a browser job).
    const images = explainGatewayError("GatewayInvalidRequestError: This model does not support image or file input. Remove it and retry.");
    expect(images?.kind).toBe("no-images");
    expect(images?.text).toContain("Models page");
    expect(explainGatewayError("fetch failed")).toBeNull();
  });
});

describe("gateway-errors", () => {
  it("imports nothing, since run_job's workflow body calls it and a workflow can't bundle the store or Node's built-ins", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("../agent/lib/gateway-errors.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/^\s*import\b|\bimport\(/m);
  });
});
