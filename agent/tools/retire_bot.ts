import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

import { record } from "../lib/activity";
import { findBot, retireBot } from "../lib/bots";
import { forgetBot } from "../lib/computer/screens";
import { cancelJob, listJobs } from "../lib/jobs";
import { operator } from "../lib/session";

export default defineTool({
  description:
    "Permanently remove a bot from the roster and cancel its open jobs. Prefer pausing with update_bot; retiring discards the bot's playbook.",
  inputSchema: z.object({
    bot: z.string().describe("Bot name or id."),
  }),
  // Irreversible and it destroys learned context, so a person signs off every time.
  approval: always(),
  label: { start: ({ bot }) => `Retire ${bot}` },
  async execute(input, ctx) {
    const who = operator(ctx);
    const found = await findBot(who.workspaceId, input.bot);
    if (found === null) return { retired: false as const, reason: `No bot called ${input.bot}.` };

    const open = await listJobs(who.workspaceId, {
      botId: found.id,
      status: ["scheduled", "queued", "dispatched", "running", "blocked"],
    });
    for (const job of open) await cancelJob(who.workspaceId, job.id);
    await retireBot(who.workspaceId, found.id);
    // The team's browser stays as it is; a handover it was waiting on is over.
    await forgetBot(who.workspaceId, found.id);
    await record({
      workspaceId: who.workspaceId,
      kind: "bot.retired",
      botId: found.id,
      text: `${found.name} was retired. ${open.length} open job(s) cancelled.`,
    });
    return { retired: true as const, cancelledJobs: open.map((job) => job.id) };
  },
});
