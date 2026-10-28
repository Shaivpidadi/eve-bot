import { defineTool } from "eve/tools";
import { z } from "zod";

import { callPageTool } from "../lib/gate";
import { toolReturned, UNTRUSTED_TOOLS } from "../lib/page-tools";

/**
 * Calls one tool the page offers (WebMCP), checked first the way a click is
 * (see `callPageTool` in `lib/gate.ts`): a tool whose name reads like send,
 * pay, delete or save is not called, and comes back as a proposal for
 * `page_confirm`; any other is called with the network guard on, and becomes a
 * proposal too if it tries to send anything but a read.
 */
export default defineTool({
  description:
    "Call one tool the current page offers (see page_tools), with parameters that match its input schema. Reports the tool's result and what it changed on the page, like page_click. A tool that could send, pay, publish, delete or save something is not called: it comes back with needsApproval and a proposal for page_confirm.",
  inputSchema: z.object({
    name: z.string().min(1).max(200).describe("The tool's name, as page_tools listed it."),
    params: z.record(z.string(), z.unknown()).default({}).describe("The tool's input, matching its schema."),
    frame: z.string().min(1).max(200).optional().describe("The frame, when the page has the same name in more than one."),
  }),
  label: { start: ({ name }) => `Use page tool ${name}` },
  async execute({ name, params, frame }, ctx) {
    if (JSON.stringify(params).length > 8_000) return { called: false as const, name, error: "The parameters are too long (over 8,000 characters)." };
    const called = await callPageTool(ctx, name, params, frame);
    if (!called.ok) return { called: false as const, name, ...called.result };
    const { ok: _ok, returned, ...seen } = called.acted;
    return { called: true as const, name, ...toolReturned(returned ?? null), ...seen, untrusted: UNTRUSTED_TOOLS };
  },
});
