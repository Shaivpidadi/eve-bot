import { defineTool } from "eve/tools";

import { NOTIFY_DESCRIPTION, notifyInput, runNotify } from "../../../lib/notify-tool";
import { guardSideEffect } from "../../../lib/run-guard";
import { operator } from "../../../lib/session";

export default defineTool({
  description: NOTIFY_DESCRIPTION,
  inputSchema: notifyInput,
  label: { start: ({ title }) => `Notify: ${title}` },
  async execute(input, ctx) {
    // A job cancelled or taken over by another run tells nobody anything.
    const guard = await guardSideEffect(ctx);
    if (!guard.ok) return { sent: false as const, reason: guard.message };
    const who = operator(ctx);
    return runNotify(input, { workspaceId: who.workspaceId, botId: who.botId });
  },
});
