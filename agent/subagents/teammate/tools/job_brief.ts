import { defineTool } from "eve/tools";
import { z } from "zod";

import { recentActivity } from "../../../lib/activity";
import { ensureComputerRestored } from "../../../lib/computer-backup";
import { getBot } from "../../../lib/bots";
import { getJob, patchJob } from "../../../lib/jobs";
import { operator } from "../../../lib/session";
import { bindScreen } from "../lib/browser";

export default defineTool({
  description:
    "Read the authoritative record for the job you were given: the brief, the success criteria, your own persona and playbook, and what has already been logged. Call this first, every time.",
  inputSchema: z.object({
    jobId: z.string().describe("The job id from your briefing message."),
  }),
  label: { start: ({ jobId }) => `Read job ${jobId}` },
  async execute({ jobId }, ctx) {
    const who = operator(ctx);
    // Every job starts here, so this is where a replaced computer gets its files back.
    await ensureComputerRestored(ctx);
    const job = await getJob(who.workspaceId, jobId);
    if (job === null) {
      return {
        found: false as const,
        reason: `No job ${jobId}. Work from the briefing message and say so in your summary.`,
      };
    }
    if (job.sessionId !== ctx.session.id) {
      // Links this run's session to the job, which is how the console follows the run.
      await patchJob(who.workspaceId, jobId, (current) => ({ ...current, sessionId: ctx.session.id }));
    }
    // Every browser action this run takes happens on the Bot's own screen.
    await bindScreen(ctx, job.botId, jobId);
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
        /** Set when a person sent the last result back: revise it to address this. */
        feedback: job.feedback ?? null,
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
