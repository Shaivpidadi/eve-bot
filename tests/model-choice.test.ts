import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CatalogModel } from "../agent/lib/gateway-models";

/**
 * The console's model choice reaches the agents: HQ picks it per turn, a job's
 * run writes it into the brief, and the teammate follows the brief, so a run
 * never switches model halfway (on any instance) and a change applies next run.
 */

const catalog = {
  models: [
    {
      id: "free/eyes",
      name: "Eyes",
      provider: "free",
      free: true,
      inputPerM: 0,
      priceVaries: false,
      outputPerM: 0,
      context: 1_000_000,
      vision: true,
      structured: true,
      reasoning: false,
      zdr: "none",
    } satisfies CatalogModel,
  ],
};

const auth = (workspaceId: string) => ({ current: { principalId: "op", principalType: "user", authenticator: "test", attributes: { workspaceId, room: "desk" } }, initiator: null });
/** An agent's dynamic model (eve 0.84): evaluated before every model call, with what it kept for the session. */
type Handlers = { model: { evaluate: (ctx: unknown) => unknown } };

/** One session as the model sees it: its memo, kept across calls, and the turn the call is in. */
function sessionOf(id: string, workspaceId: string, messages: readonly unknown[] = []) {
  const kept = new Map<string, unknown>();
  const memo = async (key: unknown, fn: (occurrence: unknown) => unknown) => {
    const name = JSON.stringify(key);
    if (!kept.has(name)) kept.set(name, await fn({ idempotencyKey: name, abortSignal: new AbortController().signal }));
    return kept.get(name);
  };
  return (turn = "turn_0") => ({ session: { id, auth: auth(workspaceId) }, turn: { id: turn, status: "running", input: [] }, memo, messages: async () => messages });
}

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv("BOT_STORE", "memory");
  vi.stubEnv("BOT_MODEL_BASE_URL", "");
  vi.stubEnv("BOT_HQ_MODEL", "");
  vi.stubEnv("BOT_TEAMMATE_MODEL", "");
  vi.stubEnv("BOT_ZDR", "");
});

describe("the brief's model line", () => {
  it("reads back what it wrote, and nothing when there is none", async () => {
    const { modelInBrief, modelLine } = await import("../agent/lib/models");
    expect(modelInBrief(`effort: quick\n${modelLine({ id: "free/eyes", context: 1_000_000, reasoning: false })}\n`)).toEqual({ id: "free/eyes", context: 1_000_000, reasoning: false, level: null });
    expect(modelInBrief(`effort: quick\n${modelLine({ id: "acme/plain" })}`)).toEqual({ id: "acme/plain", context: null, reasoning: null, level: null });
    expect(modelInBrief("effort: quick")).toBeNull();
  });
});

describe("HQ", () => {
  // Gateway's listing is not reached here: a picked model goes to eve by name.
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unavailable", { status: 503 })));
    return () => vi.unstubAllGlobals();
  });

  it("runs on the deployment's default until the workspace picks a model, then on that from the next turn", async () => {
    const hq = ((await import("../agent/agent")) as { default: Handlers }).default;
    const s1 = sessionOf("s1", "ws1");
    expect(await hq.model.evaluate(s1("turn_0"))).toEqual({ model: "anthropic/claude-sonnet-5" });
    const { saveModelSettings } = await import("../agent/lib/model-settings");
    await saveModelSettings("ws1", { roles: { hq: "free/eyes" } }, "op", catalog);
    // A turn keeps the model it started with; the pick applies from the next one.
    expect(await hq.model.evaluate(s1("turn_0"))).toEqual({ model: "anthropic/claude-sonnet-5" });
    // A model Gateway lists is left for eve to look up, so its output limit comes with it rather than a 4,096-token default.
    expect(await hq.model.evaluate(s1("turn_1"))).toEqual({ model: "free/eyes", reasoning: "provider-default" });
    // One it doesn't list gets a context window, since eve could not look one up.
    await saveModelSettings("ws1", { roles: { hq: "acme/unlisted" } }, "op", catalog);
    expect(await hq.model.evaluate(s1("turn_2"))).toMatchObject({ model: "acme/unlisted", modelContextWindowTokens: 128_000 });
    // Another workspace keeps its own.
    expect(await hq.model.evaluate(sessionOf("s2", "ws2")())).toEqual({ model: "anthropic/claude-sonnet-5" });
  });

  it("keeps Zero Data Retention on whatever model is picked", async () => {
    vi.stubEnv("BOT_ZDR", "1");
    const hq = ((await import("../agent/agent")) as { default: Handlers }).default;
    expect(await hq.model.evaluate(sessionOf("s1", "ws1")())).toEqual({
      model: "anthropic/claude-sonnet-5",
      modelOptions: { providerOptions: { gateway: { zeroDataRetention: true } } },
    });
  });
});

describe("a Bot's job", () => {
  it("runs on the model its brief names, and by its effort when the brief names none", async () => {
    const teammate = ((await import("../agent/subagents/teammate/agent")) as { default: Handlers }).default;
    const turn = (_event: unknown, ctx: { session: { id: string; auth?: unknown }; messages: readonly unknown[] }) => teammate.model.evaluate(sessionOf(ctx.session.id, "ws1", ctx.messages)());
    const brief = (lines: string) => [{ role: "user", content: `## Job\nid: job_1\n${lines}\n\nDo the thing.` }];
    expect(await turn({}, { session: { id: "run_a", auth: auth("ws1") }, messages: brief("effort: quick\nmodel: free/eyes context=1000000 reasoning=no") })).toEqual({
      model: "free/eyes",
      modelContextWindowTokens: 1_000_000,
      reasoning: "provider-default",
    });
    expect(await turn({}, { session: { id: "run_b", auth: auth("ws1") }, messages: brief("effort: deep") })).toEqual({ model: "anthropic/claude-opus-5" });
    // eve puts memory and other instructions ahead of the brief as user messages; the brief is still found.
    const memory = { role: "user", content: "# How to do your work: what the team remembers\n\neffort: quick" };
    expect(await turn({}, { session: { id: "run_c", auth: auth("ws1") }, messages: [memory, ...brief("effort: deep\nmodel: free/eyes")] })).toMatchObject({ model: "free/eyes" });
    expect(await turn({}, { session: { id: "run_d", auth: auth("ws1") }, messages: [memory, ...brief("effort: deep")] })).toEqual({ model: "anthropic/claude-opus-5" });
  });
});

describe("a model picked in the console", () => {
  const listing = { data: [{ id: "free/eyes", name: "Eyes", type: "language", tags: ["tool-use"], context_window: 1_000_000, max_tokens: 524_288, pricing: { input: "0", output: "0" } }] };

  it("is asked for its own output limit at each step, not the provider's 4,096-token default", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(listing))));
    try {
      const teammate = ((await import("../agent/subagents/teammate/agent")) as { default: Handlers }).default;
      const step = (_event: unknown, ctx: { session: { id: string; auth?: unknown }; messages: readonly unknown[] }) => teammate.model.evaluate(sessionOf(ctx.session.id, "ws1", ctx.messages)());
      const brief = (lines: string) => [{ role: "user", content: `## Job\nid: job_1\n${lines}\n\nDo the thing.` }];
      const picked = (await step({}, { session: { id: "run_p", auth: auth("ws1") }, messages: brief("effort: quick\nmodel: free/eyes") })) as { model: unknown; modelContextWindowTokens: number };
      // A live model rather than an id, told the listed context window too.
      expect(typeof picked.model).toBe("object");
      expect(picked.modelContextWindowTokens).toBe(1_000_000);
      // A job on the default models runs on them as before.
      expect(await step({}, { session: { id: "run_q", auth: auth("ws1") }, messages: brief("effort: deep") })).toEqual({ model: "anthropic/claude-opus-5" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("writes at most a ceiling's worth in one call, and is left as it was when Gateway lists no limit", async () => {
    const { withOutputLimit } = await import("../agent/lib/models");
    const selection = { model: "free/eyes", reasoning: "provider-default" as const };
    expect(withOutputLimit(selection, null)).toBe(selection);
    expect(withOutputLimit(selection, { context: 1000, maxOutput: null })).toBe(selection);
    const live = withOutputLimit(selection, { context: 1000, maxOutput: 524_288 }) as { model: { doGenerate: unknown }; reasoning: string; modelContextWindowTokens: number };
    expect(live).toMatchObject({ reasoning: "provider-default", modelContextWindowTokens: 1000 });
    expect(typeof live.model.doGenerate).toBe("function");
  });
});
