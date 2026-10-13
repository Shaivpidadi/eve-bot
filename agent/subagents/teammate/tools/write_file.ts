import { defineTool } from "eve/tools";

import { COMPUTER_PATHS } from "../../../lib/computer";
import { isolatedWriteFile } from "../../../lib/computer/shell";
import { journal } from "../lib/journal";

/**
 * eve's `write_file`, writing as the Bot shell's own user (see `lib/computer/shell.ts`).
 * A file written where the team keeps work (a Bot's folder or the shared one)
 * goes in the job's journal; per-run scratch does not.
 */
const KEPT = [COMPUTER_PATHS.bots, COMPUTER_PATHS.shared];

export default defineTool({
  ...isolatedWriteFile,
  async execute(input, ctx) {
    // eve's write_file answers with one result, never a stream.
    const output = (await isolatedWriteFile.execute(input, ctx)) as { existed: boolean; path: string };
    const { filePath, content } = input as { filePath?: unknown; content?: unknown };
    if (typeof filePath === "string" && KEPT.some((root) => filePath.startsWith(`${root}/`))) {
      await journal(ctx, {
        kind: "file",
        text: `Wrote ${filePath}`,
        data: { path: filePath, bytes: typeof content === "string" ? Buffer.byteLength(content) : 0 },
      });
    }
    return output;
  },
});
