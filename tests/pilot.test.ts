import { describe, expect, it } from "vitest";

import { candidateActions, readChoice, stepQuestion, stopBefore } from "../agent/subagents/teammate/lib/pilot";
import type { Judgement } from "../agent/lib/jev";

const TREE = `[BEGIN PAGE CONTENT]
- heading "Billing" [level=1]
- link "Invoices" [ref=e3]
- button "Download latest" [ref=e4]
- textbox "Search invoices" [ref=e5]
- button "Pay now" [ref=e6]
- StaticText "No payment due"
[END PAGE CONTENT]`;

describe("candidateActions", () => {
  it("offers the controls that have refs, and nothing else", () => {
    const candidates = candidateActions(TREE);
    expect(candidates.map((candidate) => candidate.ref)).toEqual(["@e3", "@e4", "@e6"]);
    expect(candidates[0]).toMatchObject({ id: "a1", role: "link", name: "Invoices", action: "click" });
  });

  it("offers a field only when there is text to type into it", () => {
    expect(candidateActions(TREE).some((candidate) => candidate.action === "fill")).toBe(false);
    const typing = candidateActions(TREE, { canType: true });
    expect(typing.find((candidate) => candidate.ref === "@e5")).toMatchObject({ action: "fill" });
  });

  it("marks anything that spends or sends", () => {
    const candidates = candidateActions(TREE);
    expect(candidates.find((candidate) => candidate.ref === "@e6")?.consequential).toBe(true);
    expect(candidates.find((candidate) => candidate.ref === "@e4")?.consequential).toBe(false);
  });
});

describe("stepQuestion", () => {
  it("offers every control plus done and stuck", () => {
    const candidates = candidateActions(TREE);
    const criteria = (stepQuestion("find the latest invoice", candidates).next as { criteria: Record<string, string> }).criteria;
    expect(Object.keys(criteria)).toEqual(["done", "stuck", "a1", "a2", "a3"]);
    expect(criteria.a2).toContain('Click the button "Download latest"');
  });
});

describe("stopBefore", () => {
  const base = { step: 0, maxSteps: 8, now: 1_000, deadline: 60_000, cancelled: false, idleRuns: 0 };

  it("lets an ordinary step through", () => {
    expect(stopBefore(base)).toBeNull();
  });

  it("stops on cancellation, the step cap, the clock, and a page that stopped reacting", () => {
    expect(stopBefore({ ...base, cancelled: true })).toBe("cancelled");
    expect(stopBefore({ ...base, step: 8 })).toBe("out-of-steps");
    expect(stopBefore({ ...base, now: 60_001 })).toBe("out-of-time");
    expect(stopBefore({ ...base, idleRuns: 2 })).toBe("no-progress");
  });
});

describe("readChoice", () => {
  const candidates = candidateActions(TREE);
  const answer = (choice: string, confidence = 0.9): Judgement<Record<string, never>> =>
    ({ answers: { next: { type: "choice", choice } }, confidence: { next: confidence }, inputTokens: 50 }) as never;

  it("picks the control it was told to", () => {
    expect(readChoice(answer("a2"), candidates).pick?.ref).toBe("@e4");
  });

  it("hands back rather than guessing", () => {
    expect(readChoice(null, candidates).stop).toBe("unavailable");
    expect(readChoice(answer("a2", 0.2), candidates).stop).toBe("unsure");
    expect(readChoice(answer("nonsense"), candidates).stop).toBe("unsure");
    expect(readChoice(answer("done"), candidates).stop).toBe("reached");
    expect(readChoice(answer("stuck"), candidates).stop).toBe("stuck");
  });

  it("refuses to spend or send on its own, and says which control it stopped at", () => {
    const stopped = readChoice(answer("a3"), candidates);
    expect(stopped.stop).toBe("consequential");
    expect(stopped.pick?.name).toBe("Pay now");
    expect(readChoice(answer("a3"), candidates, { allowConsequential: true }).stop).toBeNull();
  });
});
