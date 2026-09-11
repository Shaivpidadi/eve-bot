import { defineTool, toolOutput, toolOutputPart } from "eve/tools";
import { z } from "zod";

import { looseBoolean } from "../../../lib/tool-input";

import { browser, sessionDirectory } from "../lib/browser";

const MAX_INLINE_BYTES = 3 * 1024 * 1024;

export default defineTool({
  description:
    "Capture what the page looks like right now. Use it to see a page you cannot make sense of from the tree, and to prove an action landed — then keep the file with save_artifact.",
  inputSchema: z.object({
    name: z
      .string()
      .max(60)
      .optional()
      .describe("File name, saved in this run's folder on the computer. Defaults to shot.png."),
    fullPage: looseBoolean().optional().describe("Capture the whole page instead of the viewport."),
  }),
  label: { start: ({ name }) => `Screenshot ${name ?? "the page"}` },
  async execute({ name, fullPage }, ctx) {
    const raw = (name ?? "shot.png").replaceAll("/", "-");
    const path = `${await sessionDirectory(ctx)}/${raw.endsWith(".png") ? raw : `${raw}.png`}`;

    const result = await browser(ctx, [
      "screenshot",
      path,
      ...(fullPage === true ? ["--full"] : []),
    ]);
    if (!result.ok) {
      return {
        captured: false as const,
        path: null,
        bytes: 0,
        base64: null,
        error: result.error ?? result.output,
      };
    }

    const sandbox = await ctx.getSandbox();
    const bytes = await sandbox.readBinaryFile({ path });
    const inline =
      bytes !== null && bytes.byteLength <= MAX_INLINE_BYTES
        ? Buffer.from(bytes).toString("base64")
        : null;

    return {
      captured: true as const,
      path,
      bytes: bytes?.byteLength ?? 0,
      base64: inline,
      error: null,
    };
  },
  /**
   * The model gets the pixels; the path is what it hands to save_artifact.
   * Keeping the base64 out of model history matters — an inline image is
   * re-sent on every later model call.
   */
  toModelOutput(output) {
    if (!output.captured || output.base64 === null) {
      return toolOutput.json({
        captured: output.captured,
        path: output.path,
        error: output.error ?? "Screenshot saved but too large to display inline.",
      });
    }
    return toolOutput.content([
      toolOutputPart.text(`Screenshot of the current page, saved to ${output.path}:`),
      toolOutputPart.file(output.base64, { mediaType: "image/png" }),
    ]);
  },
});
