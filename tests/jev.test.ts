import { describe, expect, it } from "vitest";

import { confidenceFloor, gatewayReachable, jevEnabled, verdictOf } from "../agent/lib/jev";
import { authWallQuestions, completionQuestions, unmetCriteria } from "../agent/lib/jev-watch";
import type { Judgement } from "../agent/lib/jev";

describe("jevEnabled", () => {
  it("stays off where the Gateway cannot be reached, whatever the flag says", () => {
    expect(jevEnabled({})).toBe(false);
    expect(jevEnabled({ BOT_JEV: "on" })).toBe(false);
    expect(jevEnabled({ BOT_MODEL_BASE_URL: "http://localhost:11434/v1" })).toBe(false);
  });

  it("runs on a custom endpoint as long as a Gateway key is there", () => {
    expect(jevEnabled({ BOT_MODEL_BASE_URL: "http://localhost:11434/v1", AI_GATEWAY_API_KEY: "k" })).toBe(true);
    expect(gatewayReachable({ VERCEL_OIDC_TOKEN: "t" })).toBe(true);
  });

  it("is off when asked to be off", () => {
    expect(jevEnabled({ AI_GATEWAY_API_KEY: "k", BOT_JEV: "off" })).toBe(false);
    expect(jevEnabled({ AI_GATEWAY_API_KEY: "k", BOT_JEV: "0" })).toBe(false);
  });

  it("reads a confidence floor, and ignores nonsense", () => {
    expect(confidenceFloor({ BOT_JEV_CONFIDENCE: "0.8" })).toBe(0.8);
    expect(confidenceFloor({ BOT_JEV_CONFIDENCE: "banana" })).toBe(0.6);
    expect(confidenceFloor({ BOT_JEV_CONFIDENCE: "2" })).toBe(0.6);
  });
});

describe("verdictOf", () => {
  it("answers only when the distribution is concentrated", () => {
    expect(verdictOf(0.95, 0.9, 0.6)).toBe("yes");
    expect(verdictOf(0.02, 0.9, 0.6)).toBe("no");
    expect(verdictOf(0.55, 0.9, 0.6)).toBe("unknown");
  });

  it("treats a spread answer, or none at all, as unknown", () => {
    expect(verdictOf(0.99, 0.2, 0.6)).toBe("unknown");
    expect(verdictOf(undefined, 0.9, 0.6)).toBe("unknown");
  });
});

describe("completionQuestions", () => {
  it("asks about the job as a whole and about each criterion", () => {
    const questions = completionQuestions(["The invoice is downloaded", "The total is in the summary"]);
    expect(Object.keys(questions)).toEqual(["overall", "criterion0", "criterion1"]);
    expect(questions.overall?.type).toBe("boolean");
    expect(JSON.stringify(questions.criterion1)).toContain("The total is in the summary");
  });

  it("caps how many criteria it asks about", () => {
    const questions = completionQuestions(Array.from({ length: 20 }, (_, i) => `criterion ${i}`));
    expect(Object.keys(questions).length).toBe(9);
  });

  it("asks one question about a wall", () => {
    expect(Object.keys(authWallQuestions())).toEqual(["wall"]);
  });
});

describe("unmetCriteria", () => {
  const judgement = (answers: Record<string, number>, confidence = 0.9): Judgement<Record<string, never>> =>
    ({
      answers: Object.fromEntries(
        Object.entries(answers).map(([id, probability]) => [id, { type: "boolean", probability }]),
      ),
      confidence: Object.fromEntries(Object.keys(answers).map((id) => [id, confidence])),
      inputTokens: 100,
    }) as never;

  it("names the criteria the evidence does not support", () => {
    expect(unmetCriteria(judgement({ criterion0: 0.98, criterion1: 0.01 }), 2)).toEqual([1]);
  });

  it("says nothing when it is unsure, and nothing at all without a judgement", () => {
    expect(unmetCriteria(judgement({ criterion0: 0.01 }, 0.1), 1)).toEqual([]);
    expect(unmetCriteria(null, 3)).toEqual([]);
  });
});
