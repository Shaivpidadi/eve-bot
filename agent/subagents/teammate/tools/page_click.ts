import { defineTool } from "eve/tools";
import { z } from "zod";

import { act } from "../lib/page";

export default defineTool({
  description:
    "Click one thing on the page. Prefer an @ref from the latest snapshot; a CSS selector also works. Reports what the click changed: `changed` is none (nothing happened; do not repeat it), some (`added` lists what appeared, with refs), or page (a new page; read it afresh).",
  inputSchema: z.object({
    target: z.string().min(1).describe("An @ref like @e12, or a CSS selector."),
  }),
  label: { start: ({ target }) => `Click ${target}` },
  async execute({ target }, ctx) {
    const result = await act(ctx, ["click", target]);
    if (!result.ok) {
      return {
        clicked: false as const,
        target,
        error: result.error,
        detail: result.detail,
        hint: "A covered or stale ref is the usual cause. Take a fresh snapshot, dismiss anything overlaying the element, and try again.",
      };
    }
    const { ok: _ok, ...seen } = result;
    return { clicked: true as const, target, ...seen };
  },
});
