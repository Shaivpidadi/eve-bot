import { defineTool } from "eve/tools";
import type { BashToolOutput } from "eve/tools/bash";

import { isolatedBash } from "../../../lib/computer/shell";
import { afterPoint, journal } from "../lib/journal";

/**
 * eve's `bash`, run as the computer's unprivileged `bot` user so a command can
 * never reach the team's browser around its approval gate (see `lib/computer/shell.ts`).
 * A command that fails leaves a line in the job's journal, so the next run
 * knows what did not work.
 */
export default defineTool({
  ...isolatedBash,
  async execute(input, ctx) {
    // A rewind point saved in this same step is taken before this changes any file.
    await afterPoint(ctx);
    // eve's bash answers with one result, never a stream (see lib/computer/shell.ts).
    const output = (await isolatedBash.execute(input, ctx)) as BashToolOutput;
    if (output.status === "completed" && output.exitCode !== 0) {
      const command = typeof (input as { command?: unknown }).command === "string" ? (input as { command: string }).command : "";
      await journal(ctx, {
        kind: "error",
        text: `Command exited ${output.exitCode}: ${command.replace(/\s+/g, " ").trim().slice(0, 140)}`,
        data: { tool: "bash", exitCode: output.exitCode },
      });
    }
    return output;
  },
});
