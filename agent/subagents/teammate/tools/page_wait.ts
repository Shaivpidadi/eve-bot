import { defineTool } from "eve/tools";
import { z } from "zod";

import { browser } from "../lib/browser";

export default defineTool({
  description:
    "Wait for the page to reach a state: an element to appear, text to show up, or the URL to change. Wait for the thing you expect rather than a fixed delay.",
  inputSchema: z.object({
    forText: z.string().max(200).optional().describe("Text that should appear on the page."),
    forSelector: z.string().max(200).optional().describe("An @ref or CSS selector to appear."),
    forUrl: z.string().max(300).optional().describe("URL glob, e.g. **/dashboard."),
    load: z
      .enum(["load", "domcontentloaded", "networkidle"])
      .optional()
      .describe("Wait for a lifecycle event instead."),
  }),
  label: {
    start: ({ forText, forSelector, forUrl, load }) =>
      `Wait for ${forText ?? forSelector ?? forUrl ?? load ?? "the page"}`,
  },
  async execute(input, ctx) {
    const args: string[] =
      input.forSelector !== undefined
        ? ["wait", input.forSelector]
        : input.forText !== undefined
          ? ["wait", "--text", input.forText]
          : input.forUrl !== undefined
            ? ["wait", "--url", input.forUrl]
            : input.load !== undefined
              ? ["wait", "--load", input.load]
              : ["wait", "--load", "domcontentloaded"];

    const result = await browser(ctx, args);
    return result.ok
      ? { arrived: true as const }
      : {
          arrived: false as const,
          error: result.error,
          detail: result.output,
          hint: "The condition never happened. Snapshot the page to see where it actually is.",
        };
  },
});
