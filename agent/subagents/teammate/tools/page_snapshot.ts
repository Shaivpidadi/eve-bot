import { defineTool } from "eve/tools";
import { z } from "zod";

import { looseBoolean } from "../../../lib/tool-input";

import { isLook, look } from "../lib/page";

export default defineTool({
  description:
    "Re-read the current page, settled, as an accessibility tree with fresh @refs. Trimmed to headings, text, and interactive elements within a budget; set full to get everything agent-browser sees. Take a new snapshot after anything that changes the page: refs from before a re-render are stale.",
  inputSchema: z.object({
    full: looseBoolean().optional().describe("The whole tree, untrimmed. Costly on big pages; use it when the trimmed one is missing something."),
  }),
  label: { start: ({ full }) => (full === true ? "Read the whole page" : "Read the page") },
  async execute({ full }, ctx) {
    const seen = await look(ctx, { full: full === true });
    return isLook(seen) ? { url: seen.url, page: seen.page, shown: seen.shown } : { page: null, error: seen.error, detail: seen.detail };
  },
});
