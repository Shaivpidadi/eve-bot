import { defineTool } from "eve/tools";
import { z } from "zod";

import { browser } from "../lib/browser";

export default defineTool({
  description:
    "Read a page as clean text instead of a UI tree. Use it when you only need the content — an article, a docs page, a table — not the controls. With a URL it fetches directly without opening a tab.",
  inputSchema: z.object({
    url: z.string().optional().describe("Omit to read the page you already have open."),
    filter: z.string().max(120).optional().describe("Narrow to sections matching this text."),
  }),
  label: { start: ({ url }) => `Read ${url ?? "current page"}` },
  async execute({ url, filter }, ctx) {
    const args = ["read", ...(url ? [url] : []), ...(filter ? ["--filter", filter] : [])];
    const result = await browser(ctx, args);
    return result.ok
      ? { text: result.output, source: url ?? "current page" }
      : { text: null, error: result.error, detail: result.output };
  },
});
