import { defineTool } from "eve/tools";
import { z } from "zod";

import { browser } from "../lib/browser";

/**
 * One fact from the page, instead of the page.
 *
 * "How many rows are there", "what is in this field", "where does this link
 * go" are answers of a few characters that a bot would otherwise pay for with
 * a whole accessibility tree. Reading nothing else also keeps the answer
 * unambiguous: a count is a number, not a tree to count by eye.
 */
const WHAT = ["text", "value", "attribute", "count", "title", "url"] as const;

export default defineTool({
  description:
    "Read one fact from the page without reading the whole page: the text or value of an element, an attribute, how many elements match a selector, or the page's title or URL. Use it to check a field or count rows instead of taking a snapshot.",
  inputSchema: z
    .object({
      what: z.enum(WHAT).describe('"text", "value", "attribute" and "count" need a target; "title" and "url" do not.'),
      target: z.string().min(1).max(400).optional().describe("An @ref like @e4, or a CSS selector."),
      attribute: z.string().max(100).optional().describe('With what "attribute": which one, such as "href".'),
    })
    .refine((input) => (input.what === "title" || input.what === "url") === (input.target === undefined), {
      message: 'Give a target for text, value, attribute and count; give none for title and url.',
    })
    .refine((input) => input.what !== "attribute" || input.attribute !== undefined, {
      message: 'what "attribute" needs the attribute name.',
    }),
  label: { start: ({ what, target }) => `Read ${what}${target === undefined ? "" : ` of ${target}`}` },
  async execute({ what, target, attribute }, ctx) {
    const args =
      what === "attribute"
        ? ["get", "attr", target as string, attribute as string]
        : target === undefined
          ? ["get", what]
          : ["get", what, target];
    const result = await browser(ctx, args);
    if (!result.ok) {
      return { read: false as const, what, target, error: result.error, detail: result.output };
    }
    return { read: true as const, what, ...(target === undefined ? {} : { target }), value: result.output.trim().slice(0, 4_000) };
  },
});
