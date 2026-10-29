import { defineTool } from "eve/tools";
import { z } from "zod";

import { listTools, pickTool, UNTRUSTED_TOOLS } from "../lib/page-tools";

/**
 * What the page offers to do itself (WebMCP, see `lib/page-tools.ts`): a few
 * names and descriptions, or one tool's input schema. Reading costs nothing
 * and changes nothing; calling goes through `page_tool`.
 */
const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export default defineTool({
  description:
    "List the tools the current page offers agents itself (WebMCP), or, with name, one tool's input schema. Most pages offer none. Where a page has a tool for what you need (search, filter, add to a list), page_tool is one call instead of several clicks.",
  inputSchema: z.object({
    name: z.string().min(1).max(200).optional().describe("A tool's name, to get its input schema."),
    frame: z.string().min(1).max(200).optional().describe("The frame, when the page has the same name in more than one."),
  }),
  label: { start: ({ name }) => (name === undefined ? "Look for page tools" : `Read page tool ${name}`) },
  async execute({ name, frame }, ctx) {
    const listed = await listTools(ctx);
    if (!listed.ok) return { tools: [], error: listed.error };
    if (name === undefined) {
      return {
        tools: listed.tools.slice(0, 30).map((tool) => ({ name: tool.name, description: clip(tool.description, 300), frame: tool.frame, origin: tool.origin })),
        ...(listed.tools.length > 30 ? { more: listed.tools.length - 30 } : {}),
        ...(listed.tools.length === 0 ? { note: "This page offers no tools. Use the page itself." } : { untrusted: UNTRUSTED_TOOLS }),
      };
    }
    const picked = pickTool(listed.tools, name, frame);
    if ("problem" in picked) return { tool: null, error: `${picked.problem[0]!.toUpperCase()}${picked.problem.slice(1)}.` };
    const { tool } = picked;
    return {
      tool: { name: tool.name, description: clip(tool.description, 1_000), frame: tool.frame, origin: tool.origin, inputSchema: clip(JSON.stringify(tool.inputSchema), 4_000) },
      untrusted: UNTRUSTED_TOOLS,
    };
  },
});
