import { defineTool } from "eve/tools";
import { z } from "zod";

import { browser } from "../lib/browser";

export default defineTool({
  description:
    "Re-read the current page as an accessibility tree with fresh @refs. Take a new snapshot after anything that changes the page — refs from before a re-render are stale.",
  inputSchema: z.object({}),
  label: { start: () => "Read the page" },
  async execute(_input, ctx) {
    const result = await browser(ctx, ["snapshot"]);
    return result.ok
      ? { page: result.output }
      : { page: null, error: result.error, detail: result.output };
  },
});
