import { defineTool } from "eve/tools";
import { z } from "zod";

import { browser, refreshScreen } from "../lib/browser";

export default defineTool({
  description:
    "Click something on the page. Prefer an @ref from the latest snapshot; a CSS selector also works. Returns a fresh snapshot so you can see what the click did.",
  inputSchema: z.object({
    target: z.string().min(1).describe("An @ref like @e12, or a CSS selector."),
  }),
  label: { start: ({ target }) => `Click ${target}` },
  async execute({ target }, ctx) {
    const clicked = await browser(ctx, ["click", target]);
    if (!clicked.ok) {
      return {
        clicked: false as const,
        target,
        error: clicked.error,
        detail: clicked.output,
        hint: "A covered or stale ref is the usual cause. Take a fresh snapshot, dismiss anything overlaying the element, and try again.",
      };
    }
    await refreshScreen(ctx);
    const snapshot = await browser(ctx, ["snapshot"]);
    return { clicked: true as const, target, page: snapshot.ok ? snapshot.output : null };
  },
});
