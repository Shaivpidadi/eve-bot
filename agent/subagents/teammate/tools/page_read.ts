import { defineTool } from "eve/tools";
import { z } from "zod";

import { browser, refreshScreen } from "../lib/browser";
import { forgetLook } from "../lib/page";

/**
 * The page as text, always read from the Bot's own browser.
 *
 * agent-browser's `read <url>` fetches the address afresh, outside the
 * browser and without its cookies. Pointed at an app, that fetch lands on the
 * app's sign-in page even though the browser is signed in, and a Bot reading
 * it concluded it was logged out and asked for a takeover, again and again.
 * So a URL here opens the page in the Bot's tab first, and the text is read
 * from the rendered page, with every sign-in the browser holds.
 */
export default defineTool({
  description:
    "Read a page as clean text instead of a UI tree. Use it when you only need the content, an article, a docs page, a table, an email body, not the controls. With a URL it opens that page in your browser first, signed in as your browser is, then reads it. Without one it reads the page you have open.",
  inputSchema: z.object({
    url: z.string().optional().describe("Omit to read the page you already have open."),
    filter: z.string().max(120).optional().describe("Narrow to sections matching this text."),
  }),
  label: { start: ({ url }) => `Read ${url ?? "current page"}` },
  async execute({ url, filter }, ctx) {
    if (url !== undefined) {
      const opened = await browser(ctx, ["open", url]);
      if (!opened.ok) return { text: null, source: url, error: opened.error, detail: opened.output };
      await browser(ctx, ["wait", "--load", "domcontentloaded"]);
      // This is a different page from the one the last snapshot described.
      forgetLook(ctx);
      await refreshScreen(ctx);
    }
    const result = await browser(ctx, ["read", ...(filter ? ["--filter", filter] : [])]);
    const at = await browser(ctx, ["get", "url"]);
    const source = at.ok ? at.output.trim().slice(0, 500) : (url ?? "current page");
    return result.ok
      ? { text: result.output, source }
      : { text: null, source, error: result.error, detail: result.output };
  },
});
