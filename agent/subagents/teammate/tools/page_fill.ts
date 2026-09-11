import { defineTool } from "eve/tools";
import { z } from "zod";

import { looseBoolean } from "../../../lib/tool-input";

import { browser, refreshScreen } from "../lib/browser";

export default defineTool({
  description:
    "Clear a field and type into it. Set submit to press Enter afterwards. Never pass a password or one-time code you were not explicitly given for this job.",
  inputSchema: z.object({
    target: z.string().min(1).describe("An @ref like @e7, or a CSS selector."),
    value: z.string().max(4_000),
    submit: looseBoolean().optional().describe("Press Enter after filling."),
  }),
  label: {
    // The value can be sensitive, so activity shows the field, never the text.
    start: ({ target }) => `Fill ${target}`,
  },
  async execute({ target, value, submit }, ctx) {
    const filled = await browser(ctx, ["fill", target, value]);
    if (!filled.ok) {
      return { filled: false as const, target, error: filled.error, detail: filled.output };
    }
    if (submit === true) {
      const pressed = await browser(ctx, ["press", "Enter"]);
      if (!pressed.ok) {
        return { filled: true as const, submitted: false as const, detail: pressed.output };
      }
    }
    await refreshScreen(ctx);
    const snapshot = await browser(ctx, ["snapshot"]);
    return {
      filled: true as const,
      submitted: submit === true,
      page: snapshot.ok ? snapshot.output : null,
    };
  },
});
