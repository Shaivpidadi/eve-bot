import { defineTool } from "eve/tools";
import { z } from "zod";

import { listBots } from "../lib/bots";
import { listJobs } from "../lib/jobs";
import { operator } from "../lib/session";

export default defineTool({
  description:
    "List the team: every bot, what it does, whether it is active, and what it is working on right now.",
  inputSchema: z.object({}),
  label: { start: () => "Read the roster" },
  async execute(_input, ctx) {
    const who = operator(ctx);
    const [bots, open] = await Promise.all([
      listBots(who.workspaceId),
      listJobs(who.workspaceId, { status: ["queued", "dispatched", "running", "blocked"] }),
    ]);
    return {
      workspaceId: who.workspaceId,
      bots: bots.map((bot) => ({
        id: bot.id,
        name: bot.name,
        emoji: bot.emoji,
        role: bot.role,
        status: bot.status,
        skills: bot.skills,
        lessonsLearned: bot.playbook.length,
        stats: bot.stats,
        workingOn: open
          .filter((job) => job.botId === bot.id)
          .map((job) => ({ id: job.id, title: job.title, status: job.status })),
      })),
    };
  },
});
