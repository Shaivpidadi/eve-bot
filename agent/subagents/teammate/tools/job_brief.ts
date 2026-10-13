import { defineTool } from "eve/tools";
import { z } from "zod";

import { recentActivity } from "../../../lib/activity";
import { ensureComputerRestored } from "../../../lib/computer-backup";
import { getBot } from "../../../lib/bots";
import { bindRun, describeRunRefusal } from "../../../lib/jobs";
import { operator } from "../../../lib/session";
import { bindScreen } from "../lib/browser";
import { markPoint } from "../lib/journal";

export default defineTool({
  description:
    "Read the authoritative record for the job you were given: the brief, the success criteria, your own persona and playbook, and what has already been logged. Call this first, every time.",
  inputSchema: z.object({
    jobId: z.string().describe("The job id from your briefing message."),
    runToken: z.string().describe("The run token from your briefing message. It proves this session is the job's current run."),
  }),
  label: { start: ({ jobId }) => `Read job ${jobId}` },
  async execute({ jobId, runToken }, ctx) {
    const who = operator(ctx);
    // Binds this session to the run lease it was briefed with, in one step with
    // the check: from here on only this session may write to the job, and the
    // console follows the run through it. A later run's claim undoes it, and a
    // run that was already superseded touches nothing, the computer included.
    const bound = await bindRun(who.workspaceId, jobId, runToken, ctx.session.id);
    if (!bound.ok) {
      return {
        found: false as const,
        reason: bound.reason,
        message:
          bound.reason === "missing"
            ? `No job ${jobId}. Work from the briefing message and say so in your summary.`
            : describeRunRefusal(bound.reason, jobId),
      };
    }
    // Every job starts here, so this is where a replaced computer gets its files back.
    await ensureComputerRestored(ctx);
    const job = bound.job;
    // Every browser action this run takes happens on the Bot's own screen.
    await bindScreen(ctx, job.botId, jobId);
    // Where this run begins is a point the job can be rewound to.
    await markPoint(ctx, jobId, (job.journal ?? []).length === 0 ? "start" : "resume");
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
