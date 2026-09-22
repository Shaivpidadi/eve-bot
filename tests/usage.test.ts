import { describe, expect, it } from "vitest";

import { addToLedger, addUsage, dayOf, EMPTY_LEDGER, NO_USAGE, UNREPORTED_MODEL, usageOfStep } from "../agent/lib/usage";
import { describeUsage, tokens, usd } from "../agent/lib/usage-format";

const step = (input: number, output: number, cost: number, model: string | null = "gateway/anthropic/claude-sonnet-5") =>
  usageOfStep({ usage: { inputTokens: input, outputTokens: output, cacheReadTokens: 10, cacheWriteTokens: 5, costUsd: cost } }, model);

/** What one model step reports, kept as the ledger counts it. */
describe("usage", () => {
  it("reads a step's usage and tolerates a provider that reports nothing", () => {
    expect(step(1000, 50, 0.01)).toEqual({
      inputTokens: 1000,
      outputTokens: 50,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
      costUsd: 0.01,
      steps: 1,
      models: { "gateway/anthropic/claude-sonnet-5": 1 },
    });
    expect(usageOfStep({}, null)).toEqual({ ...NO_USAGE, steps: 1 });
    expect(usageOfStep({ usage: { inputTokens: Number.NaN, costUsd: "3" } }, null)).toEqual({ ...NO_USAGE, steps: 1 });
  });

  it("adds up across steps and models without drifting", () => {
    const sum = [step(100, 10, 0.1), step(200, 20, 0.2), step(300, 30, 0.3, "qwen")].reduce(addUsage, NO_USAGE);
    expect(sum.inputTokens).toBe(600);
    expect(sum.costUsd).toBe(0.6);
    expect(sum.steps).toBe(3);
    expect(sum.cacheWriteTokens).toBe(15);
    // A record from before cache writes were kept adds up as zero there.
    const old = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, costUsd: 0, steps: 1, models: {} } as unknown as typeof sum;
    expect(addUsage(old, step(1, 1, 0)).cacheWriteTokens).toBe(5);
    expect(sum.models).toEqual({ "gateway/anthropic/claude-sonnet-5": 2, qwen: 1 });
  });

  it("keeps the ledger by who, by model and by day, and lets old days fall off", () => {
    const monday = new Date("2026-09-21T15:00:00Z");
    let ledger = addToLedger(null, "hq", step(1000, 50, 0.05), monday);
    ledger = addToLedger(ledger, { botId: "bot_a" }, step(500, 20, 0.01, "qwen"), monday);
    ledger = addToLedger(ledger, { botId: "bot_a" }, step(500, 20, 0, null), new Date("2026-09-22T09:00:00Z"));

    expect(ledger.hq.steps).toBe(1);
    expect(ledger.bots.bot_a?.steps).toBe(2);
    expect(Object.keys(ledger.byModel ?? {}).sort()).toEqual(["gateway/anthropic/claude-sonnet-5", UNREPORTED_MODEL, "qwen"].sort());
    expect(ledger.byDay?.["2026-09-21"]?.costUsd).toBe(0.06);
    expect(ledger.byDay?.["2026-09-22"]?.steps).toBe(1);

    // Ninety-one days later the first days are gone; the totals are not.
    const later = addToLedger(ledger, "hq", step(1, 1, 0), new Date("2026-12-22T09:00:00Z"));
    expect(Object.keys(later.byDay ?? {})).toEqual(["2026-12-22"]);
    expect(later.hq.steps).toBe(2);
    expect(later.bots.bot_a?.steps).toBe(2);
    expect(dayOf(new Date("2026-09-21T23:59:59Z"))).toBe("2026-09-21");
    // A ledger from before the breakdowns existed reads as empty ones.
    expect(addToLedger({ hq: NO_USAGE, bots: {}, updatedAt: "" }, "hq", step(1, 1, 0), monday).byModel).toBeDefined();
    expect(EMPTY_LEDGER.byDay).toEqual({});
  });

  it("reads the way a person does", () => {
    expect(tokens(950)).toBe("950");
    expect(tokens(46_907)).toBe("46.9k");
    expect(tokens(227_688)).toBe("228k");
    expect(tokens(2_100_000)).toBe("2.1M");
    expect(usd(0.054079)).toBe("$0.05");
    expect(usd(0.003134)).toBe("$0.003");
    expect(usd(0)).toBe("$0");
    expect(describeUsage(step(46_500, 400, 0.003134, "alibaba/qwen3.8-flash"))).toBe("alibaba/qwen3.8-flash · 46.9k tokens · $0.003");
    expect(describeUsage(undefined)).toBeNull();
  });
});

describe("Jev on the ledger", () => {
  it("counts a judgement as one step of Jev's model, priced by Gateway", async () => {
    const { spent } = await import("../agent/lib/jev");
    const usage = spent(
      { inputTokens: 1200, outputTokens: 8, inputTokenDetails: { cacheReadTokens: 1000, cacheWriteTokens: 0 } },
      { gateway: { cost: "0.0006" } },
      "typesafe-ai/jev",
    );
    expect(usage).toEqual({ inputTokens: 1200, outputTokens: 8, cacheReadTokens: 1000, cacheWriteTokens: 0, costUsd: 0.0006, steps: 1, models: { "typesafe-ai/jev": 1 } });
    expect(spent(undefined, undefined, "typesafe-ai/jev").costUsd).toBe(0);
    const ledger = addToLedger(null, "jev", usage, new Date("2026-09-21T15:00:00Z"));
    expect(ledger.jev?.steps).toBe(1);
    expect(ledger.hq.steps).toBe(0);
    expect(Object.keys(ledger.bots)).toEqual([]);
  });
});

describe("Gateway account", () => {
  it("reads balance and total used, and is null without a key or an answer", async () => {
    const { forgetGatewayAccount, gatewayAccount } = await import("../agent/lib/gateway-account");
    const previous = process.env.AI_GATEWAY_API_KEY;
    try {
      process.env.AI_GATEWAY_API_KEY = "";
      forgetGatewayAccount();
      expect(await gatewayAccount()).toBeNull();

      process.env.AI_GATEWAY_API_KEY = "vck_test";
      forgetGatewayAccount();
      const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
        expect(String(url)).toContain("/v1/credits");
        expect((init?.headers as Record<string, string>).authorization).toBe("Bearer vck_test");
        return new Response(JSON.stringify({ balance: "27.046551015", total_used: "37.027334465" }), { status: 200 });
      }) as unknown as typeof fetch;
      expect(await gatewayAccount(fetcher)).toMatchObject({ balanceUsd: 27.046551015, totalUsedUsd: 37.027334465 });

      forgetGatewayAccount();
      const down = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
      expect(await gatewayAccount(down)).toBeNull();
    } finally {
      process.env.AI_GATEWAY_API_KEY = previous;
    }
  });
});
