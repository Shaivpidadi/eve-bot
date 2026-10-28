import { defineDynamic, defineInstructions } from "eve/instructions";

import { listRecipes } from "../lib/recipes";
import { perTurn } from "../lib/dynamic";
import { operator } from "../lib/session";

/**
 * The recipes this team has, so HQ recognises a repeat request as one.
 *
 * Resolved per turn, like connectors: one saved a minute ago should be usable
 * in the next message, and one removed should stop being offered.
 */
export default defineDynamic(async (ctx) => {
  const content = await perTurn(ctx, async () => {
    const { workspaceId } = operator(ctx);
    const recipes = await listRecipes(workspaceId);
    if (recipes.length === 0) return null;
    return [
          "## Recipes",
          "",
          "Work this team has done before, kept so it comes out the same way:",
          "",
          ...recipes.slice(0, 20).map((recipe) => `- **${recipe.name}** — ${recipe.when}${recipe.uses > 0 ? ` (used ${recipe.uses}×)` : ""}`),
          "",
          "When a request matches one, pass its name as `recipe` to `assign_job` and write `brief` as only what is different this time; the recipe supplies the rest. A recipe describes what to achieve, not clicks to repeat, so the bot still reads the page as it is today and still verifies the result. After a job the operator is happy with that they will ask for again, `save_recipe` keeps it.",
    ].join("\n");
  });
  return content === null ? null : defineInstructions({ content });
});
