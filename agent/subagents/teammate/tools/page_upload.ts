import { defineTool } from "eve/tools";
import { z } from "zod";

import { act } from "../lib/page";

/**
 * Attaching a file a bot made.
 *
 * A bot can write a file on the team's computer and save it as an artifact,
 * but until now it could not hand one back to a web app: "fill this form and
 * attach the CSV" ended at the attach. A file input takes paths, and the files
 * are already sitting on the same machine as the browser.
 */
export default defineTool({
  description:
    "Attach files on the team's computer to a file input on the page. Give the input's @ref or CSS selector and the paths, which are paths on your computer — write the file first, then attach it. Reports what changed the same way page_click does.",
  inputSchema: z.object({
    target: z.string().min(1).describe('An @ref, or a CSS selector such as input[type=file].'),
    files: z
      .array(z.string().min(1).max(1_000))
      .min(1)
      .max(5)
      .describe("Paths on your computer, such as /workspace/bots/atlas/report.csv."),
  }),
  label: { start: ({ files }) => `Attach ${files.length === 1 ? (files[0] as string) : `${files.length} files`}` },
  async execute({ target, files }, ctx) {
    const result = await act(ctx, ["upload", target, ...files]);
    if (!result.ok) {
      return {
        attached: false as const,
        target,
        files,
        error: result.error,
        detail: result.detail,
        hint: "The target must be a file input, and every path must exist on your computer. Check the path with a shell command, and open the upload control first if the page hides the input behind a button.",
      };
    }
    const { ok: _ok, ...seen } = result;
    return { attached: true as const, target, files, ...seen };
  },
});
