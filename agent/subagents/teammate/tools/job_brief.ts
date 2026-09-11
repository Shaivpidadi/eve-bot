import { defineTool } from "eve/tools";
import { z } from "zod";

import { recentActivity } from "../../../lib/activity";
import { getBot } from "../../../lib/bots";
import { getJob } from "../../../lib/jobs";
import { operator } from "../../../lib/session";

export default defineTool({
  description:
    "Read the authoritative record for the job you were given: the brief, the success criteria, your own persona and playbook, and what has already been logged. Call this first, every time.",
  inputSchema: z.object({
    jobId: z.string().describe("The job id from your briefing message."),
  }),
  label: { start: ({ jobId }) => `Read job ${jobId}` },
  async execute({ jobId }, ctx) {
    const who = operator(ctx);
    const job = await getJob(who.workspaceId, jobId);
    if (job === null) {
      return {
        found: false as const,
        reason: `No job ${jobId}. Work from the briefing message and say so in your summary.`,
      };
    }
    const [bot, timeline] = await Promise.all([
      getBot(who.workspaceId, job.botId),
      recentActivity(who.workspaceId, { jobId, limit: 30 }),
    ]);

    return {
      found: true as const,
      job: {
        id: job.id,
        title: job.title,
        brief: job.brief,
        successCriteria: job.successCriteria,
        requestedBy: job.requestedBy,
        status: job.status,
        attempts: job.attempts,
        requiresSignoff: job.requiresSignoff,
        everyMinutes: job.everyMinutes,
        previousResult: job.result,
        previousError: job.error,
        artifacts: job.artifacts,
      },
      you:
        bot === null
          ? null
          : {
              name: bot.name,
              role: bot.role,
              persona: bot.persona,
              playbook: bot.playbook,
              skills: bot.skills,
            },
      alreadyLogged: timeline.map((event) => ({ at: event.at, text: event.text })),
    };
  },
});
