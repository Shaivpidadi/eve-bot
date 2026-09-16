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

  it("caps tokens per session on a custom endpoint only, with defaults, overrides, and off", async () => {
    const gateway = await import("../agent/lib/models");
    expect(gateway.tokenLimits("hq")).toEqual({});
    vi.resetModules();
    vi.stubEnv("BOT_MODEL_BASE_URL", "http://localhost:11434/v1");
    vi.stubEnv("BOT_JOB_OUTPUT_TOKEN_LIMIT", "250000");
    vi.stubEnv("BOT_HQ_INPUT_TOKEN_LIMIT", "off");
    vi.stubEnv("BOT_HQ_OUTPUT_TOKEN_LIMIT", "not-a-number");
    const custom = await import("../agent/lib/models");
    expect(custom.tokenLimits("job")).toEqual({ maxInputTokensPerSession: 10_000_000, maxOutputTokensPerSession: 250_000 });
    expect(custom.tokenLimits("hq")).toEqual({ maxInputTokensPerSession: false, maxOutputTokensPerSession: 2_000_000 });
  });
});
