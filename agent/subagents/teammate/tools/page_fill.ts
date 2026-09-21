import { defineTool } from "eve/tools";
import { z } from "zod";

import { looseBoolean } from "../../../lib/tool-input";

import { browser } from "../lib/browser";
import { act } from "../lib/page";
import { LOCATORS, missHint, targetArgs } from "../lib/target";

export default defineTool({
  description:
    "Clear a field and type into it. Name the field with an @ref, a CSS selector, or — with `by` — its label, placeholder, or text. Set submit to press Enter afterwards. Reports what changed on the page the same way page_click does. Never pass a password or one-time code you were not explicitly given for this job.",
  inputSchema: z.object({
    target: z.string().min(1).describe("An @ref like @e7, a CSS selector, or what to look for when `by` is set."),
    by: z
      .enum(LOCATORS)
      .optional()
      .describe('How to read target: "ref" (default, also CSS), or "label", "placeholder", "text", "testid", "role".'),
    name: z.string().max(200).optional().describe('With by "role": the accessible name of the field.'),
    value: z.string().max(4_000),
    submit: looseBoolean().optional().describe("Press Enter after filling."),
  }),
  label: {
    // The value can be sensitive, so activity shows the field, never the text.
    start: ({ target }) => `Fill ${target}`,
  },
  async execute({ target, by, name, value, submit }, ctx) {
    const named = { target, ...(by === undefined ? {} : { by }), ...(name === undefined ? {} : { name }) };
    if (submit === true) {
      const filled = await browser(ctx, targetArgs(named, "fill", value));
      if (!filled.ok) return { filled: false as const, target, error: filled.error, detail: filled.output, hint: missHint(named) };
      const pressed = await act(ctx, ["press", "Enter"]);
      if (!pressed.ok) return { filled: true as const, submitted: false as const, target, error: pressed.error, detail: pressed.detail };
      const { ok: _ok, ...seen } = pressed;
      return { filled: true as const, submitted: true as const, target, ...seen };
    }
    const result = await act(ctx, targetArgs(named, "fill", value));
    if (!result.ok) return { filled: false as const, target, error: result.error, detail: result.detail, hint: missHint(named) };
    const { ok: _ok, ...seen } = result;
    return { filled: true as const, submitted: false as const, target, ...seen };
  },
});
