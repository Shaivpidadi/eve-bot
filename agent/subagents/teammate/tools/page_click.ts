import { defineTool } from "eve/tools";
import { z } from "zod";

import { act } from "../lib/page";
import { LOCATORS, missHint, targetArgs } from "../lib/target";

export default defineTool({
  description:
    "Click one thing on the page. Name it with an @ref from the latest snapshot, a CSS selector, or — with `by` — the control's own text, label, placeholder, test id, or role, which saves reading the page first. Reports what the click changed: `changed` is none (nothing happened; do not repeat it), some (`added` lists what appeared, with refs), or page (a new page; read it afresh).",
  inputSchema: z.object({
    target: z.string().min(1).describe("An @ref like @e12, a CSS selector, or what to look for when `by` is set."),
    by: z
      .enum(LOCATORS)
      .optional()
      .describe('How to read target: "ref" (default, also CSS), or "text", "label", "placeholder", "testid", "role".'),
    name: z.string().max(200).optional().describe('With by "role": the accessible name, such as "Send".'),
  }),
  label: { start: ({ target }) => `Click ${target}` },
  async execute({ target, by, name }, ctx) {
    const named = { target, ...(by === undefined ? {} : { by }), ...(name === undefined ? {} : { name }) };
    const result = await act(ctx, targetArgs(named, "click"));
    if (!result.ok) {
      return {
        clicked: false as const,
        target,
        error: result.error,
        detail: result.detail,
        hint: missHint(named),
      };
    }
    const { ok: _ok, ...seen } = result;
    return { clicked: true as const, target, ...seen };
  },
});
