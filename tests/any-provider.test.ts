import { experimental_decide as decide } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What used to need AI Gateway works on any OpenAI-compatible provider: the
 * Models page lists and saves that provider's own models, Jev's questions are
 * answered by a chat model there, and memory by meaning uses its embedding
 * model. Choices made for one provider never reach another.
 */

const OLLAMA = "http://localhost:11434/v1";

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.stubEnv("BOT_STORE", "memory");
  vi.stubEnv("BOT_COMPUTER_KEY", "k".repeat(40));
  vi.stubEnv("BOT_MODELS_EDITABLE", "");
  vi.stubEnv("BOT_JEV", "");
  vi.stubEnv("BOT_MEMORY_EMBEDDINGS", "");
  vi.stubEnv("BOT_MEMORY_EMBEDDING_MODEL", "");
});
afterEach(() => vi.unstubAllEnvs());

const onOllama = () => {
  vi.stubEnv("BOT_MODEL_BASE_URL", OLLAMA);
  vi.stubEnv("BOT_MODEL", "qwen3:8b");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => (String(url) === `${OLLAMA}/models` ? Response.json({ data: [{ id: "qwen3:8b" }, { id: "llama3.3:70b" }, { id: "not a model" }] }) : new Response("{}", { status: 404 }))),
  );
};

describe("the Models page on your own provider", () => {
  it("lists what the provider serves, and saves one of its models for a role", async () => {
    onOllama();
    const settings = await import("../agent/lib/model-settings");
    const catalog = await settings.endpointCatalog();
    expect(catalog.models.map((model) => model.id)).toEqual(["qwen3:8b", "llama3.3:70b"]);
    expect(settings.modelsEditable()).toBe(true);
    expect(await settings.saveModelSettings("ws", { roles: { deep: "llama3.3:70b" } }, "op", catalog)).toMatchObject({ ok: true });
    expect(await settings.resolveModel("ws", "deep")).toMatchObject({ id: "llama3.3:70b", source: "setting" });
    expect(await settings.runModel("ws", "deep")).toMatchObject({ id: "llama3.3:70b" });
    // A role nobody chose picks by effort, as before, and names nothing in the brief.
    expect(await settings.runModel("ws", "quick")).toBeNull();
  });

  it('keeps "Free models only" to AI Gateway', async () => {
    onOllama();
    const settings = await import("../agent/lib/model-settings");
    expect(await settings.saveModelSettings("ws", { freeOnly: true }, "op", await settings.endpointCatalog())).toMatchObject({ ok: false, error: expect.stringMatching(/AI Gateway/) });
  });

  it("never applies choices made for one provider to another", async () => {
    onOllama();
    const settings = await import("../agent/lib/model-settings");
    await settings.saveModelSettings("ws", { roles: { hq: "qwen3:8b" } }, "op", await settings.endpointCatalog());
    vi.resetModules();
    vi.stubEnv("BOT_MODEL_BASE_URL", "");
    const onGateway = await import("../agent/lib/model-settings");
    expect((await onGateway.resolveModel("ws", "hq")).source).toBe("default");
  });
});

describe("Jev on your own provider", () => {
  it("is on there, and a chat model answers its questions in the decision model's shape", async () => {
    onOllama();
    const { jevEnabled } = await import("../agent/lib/jev");
    expect(jevEnabled({})).toBe(true);
    const asked: string[] = [];
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        asked.push(JSON.stringify(options.prompt));
        return {
          content: [{ type: "text", text: JSON.stringify({ wall: "login", done: 2, met: { answer: true, probability: 0.9 } }) }],
          finishReason: { unified: "stop", raw: "stop" },
          usage: { inputTokens: { total: 50, noCache: 50, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } },
          warnings: [],
        };
      },
    });
    const { chatDecisionModel } = await import("../agent/lib/endpoint-decisions");
    const result = await decide({
      model: chatDecisionModel(model as never, "qwen3:8b"),
      state: [{ type: "text", text: "The page says: Sign in to continue." }],
      questions: {
        wall: { type: "choice", instructions: "What is this page?", criteria: { login: "A sign-in wall", content: null } },
        done: { type: "score", instructions: "How far along is the job?", criteria: ["not started", "halfway", "done"] },
        met: { type: "boolean", instructions: "Is the brief met?" },
      },
    });
    expect(result.answers).toMatchObject({ wall: { choice: "login" }, done: { score: 2 }, met: { probability: 0.9 } });
    expect(asked[0]).toContain("Sign in to continue");
    expect(asked[0]).toContain("login: A sign-in wall");
  });
});

describe("memory by meaning on your own provider", () => {
  it("is on once an embedding model it serves is named", async () => {
    onOllama();
    const { embeddingsEnabled } = await import("../agent/lib/memory/embeddings");
    expect(embeddingsEnabled({})).toBe(false);
    expect(embeddingsEnabled({ BOT_MEMORY_EMBEDDING_MODEL: "nomic-embed-text" })).toBe(true);
    expect(embeddingsEnabled({ BOT_MEMORY_EMBEDDING_MODEL: "nomic-embed-text", BOT_MEMORY_EMBEDDINGS: "off" })).toBe(false);
  });
});

describe("a small model's answers to Jev's questions", () => {
  const questions = {
    wall: { type: "choice", instructions: "What is it?", criteria: { "sign-in wall": null, content: null } },
    done: { type: "score", instructions: "How far?", criteria: ["none", "half", "all"] },
    met: { type: "boolean", instructions: "Met?" },
  } as const;

  it("are read from JSON that misses the shape asked, nested or flat", async () => {
    const { lenient } = await import("../agent/lib/endpoint-decisions");
    expect(lenient('Here you go: {"wall": {"choice": "Sign-in wall"}, "done": "2", "met": "yes"}', questions as never)).toEqual({ wall: "sign-in wall", done: 2, met: { answer: true } });
    expect(lenient('{"wall": "it is the content", "done": 9, "met": {"answer": false, "probability": 0.8}}', questions as never)).toEqual({ wall: "content", done: 2, met: { answer: false, probability: 0.8 } });
    expect(lenient("I could not decide.", questions as never)).toEqual({});
  });

  it("give P(true) agreeing with the answer, from a probability, a confidence or a percentage", async () => {
    const { chatDecisionModel } = await import("../agent/lib/endpoint-decisions");
    const reply = (met: unknown) =>
      new MockLanguageModelV4({
        doGenerate: async () => ({
          content: [{ type: "text", text: JSON.stringify({ met }) }],
          finishReason: { unified: "stop", raw: "stop" },
          usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
          warnings: [],
        }),
      });
    const ask = async (met: unknown) =>
      (await decide({ model: chatDecisionModel(reply(met) as never, "m"), state: [{ type: "text", text: "x" }], questions: { met: questions.met } })).answers.met;
    expect(await ask({ answer: true, probability: 0.9 })).toMatchObject({ probability: 0.9 });
    // A sure "no" given as confidence in the answer.
    expect((await ask({ answer: false, probability: 0.9 })) as { probability: number }).toMatchObject({ probability: expect.closeTo(0.1, 5) });
    expect(await ask({ answer: true, probability: 95 })).toMatchObject({ probability: 0.95 });
  });
});
