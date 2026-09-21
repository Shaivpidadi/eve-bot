import { describe, expect, it } from "vitest";

import { briefFromRecipe, type Recipe } from "../agent/lib/recipes";

const recipe: Recipe = {
  id: "recipe_1",
  workspaceId: "default",
  name: "weekly competitor prices",
  when: "Someone asks what the competition is charging",
  brief: "Open each vendor's pricing page and record the plan names and monthly prices.",
  successCriteria: ["Every vendor has a price", "The table is saved as an artifact"],
  notes: ["Fabrikam hides its price behind a Contact us form; use the cached page."],
  fromJobId: "job_9",
  botId: "bot_atlas",
  createdAt: "2026-09-01T09:00:00.000Z",
  createdBy: "operator",
  uses: 3,
};

describe("briefFromRecipe", () => {
  it("puts what was asked for today first", () => {
    const brief = briefFromRecipe(recipe, "Only the three vendors we lost deals to.");
    expect(brief.startsWith("This time: Only the three vendors we lost deals to.")).toBe(true);
    expect(brief).toContain("Open each vendor's pricing page");
  });

  it("carries the warnings that made last time hard", () => {
    expect(briefFromRecipe(recipe, undefined)).toContain("Fabrikam hides its price");
  });

  it("tells the bot to read the page as it is now", () => {
    const brief = briefFromRecipe(recipe, undefined);
    expect(brief).toMatch(/may have moved/i);
    expect(brief).toMatch(/do not assume the same buttons/i);
  });

  it("works for a recipe with no notes", () => {
    const bare = { ...recipe, notes: [] };
    expect(briefFromRecipe(bare, "go")).toContain("This time: go");
    expect(briefFromRecipe(bare, "go")).not.toContain("Watch out for");
  });
});
