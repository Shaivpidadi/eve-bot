import { describe, expect, it } from "vitest";

import { prefersMarkdown } from "../src/site/accept";

/** Which askers get Markdown from the public pages. */
describe("prefersMarkdown", () => {
  it("answers Markdown to an agent that asks for it, ties included", () => {
    expect(prefersMarkdown("text/markdown")).toBe(true);
    expect(prefersMarkdown("text/markdown, text/html;q=0.9")).toBe(true);
    expect(prefersMarkdown("text/html, text/markdown")).toBe(true);
    expect(prefersMarkdown("Text/Markdown;q=0.8, */*;q=0.1")).toBe(true);
  });

  it("keeps HTML for browsers and for anyone who ranks HTML higher", () => {
    expect(prefersMarkdown(null)).toBe(false);
    expect(prefersMarkdown("")).toBe(false);
    expect(prefersMarkdown("text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")).toBe(false);
    expect(prefersMarkdown("text/html, text/markdown;q=0.5")).toBe(false);
    expect(prefersMarkdown("text/markdown;q=0")).toBe(false);
    expect(prefersMarkdown("*/*")).toBe(false);
  });
});
