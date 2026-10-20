import { defineTool } from "eve/tools";

import { NOTIFY_DESCRIPTION, notifyInput, runNotify } from "../lib/notify-tool";
import { operator } from "../lib/session";

export default defineTool({
  description: NOTIFY_DESCRIPTION,
  inputSchema: notifyInput,
  label: { start: ({ title }) => `Notify: ${title}` },
  async execute(input, ctx) {
    const who = operator(ctx);
    return runNotify(input, { workspaceId: who.workspaceId, botId: who.botId });
  },
});
