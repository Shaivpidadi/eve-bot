import { defineTool } from "eve/tools";
import { z } from "zod";

import { gate } from "../lib/gate";

/**
 * Attaching a file a bot made.
 *
 * A bot can write a file on the team's computer and save it as an artifact,
 * but until now it could not hand one back to a web app: "fill this form and
 * attach the CSV" ended at the attach. A file input takes paths, and the files
 * are already sitting on the same machine as the browser.
 *
 * Attaching hands a file to a site, so it is always a proposal: a person
 * approves it through `page_confirm`, which attaches exactly those files to
 * exactly that input.
 */
export default defineTool({
  description:
    "Attach files on the team's computer to a file input on the page. Give the input's @ref or CSS selector and the paths, which are paths on your computer — write the file first, then attach it. Nothing is attached straight away: it comes back with needsApproval and a proposal, and page_confirm attaches the files once a person approves.",
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
    const checked = await gate(ctx, { kind: "upload", target: { target }, action: (selector) => ["upload", selector, ...files], files });
    // The classifier never calls an upload safe; this is the proposal, or why there is none.
    if (!checked.go) {
      return {
        attached: false as const,
        target,
        files,
        ...checked.result,
        hint: "The target must be a file input, and every path must exist on your computer. Check the path with a shell command, and open the upload control first if the page hides the input behind a button.",
      };
    }
    return { attached: false as const, target, files, error: "Attaching a file always needs a person's approval." };
  },
});
