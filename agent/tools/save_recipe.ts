import { defineTool } from "eve/tools";
import { z } from "zod";

import { getJob } from "../lib/jobs";
import { saveRecipe } from "../lib/recipes";
import { operator } from "../lib/session";

/**
 * Keeping work that went well.
 *
 * The third time the operator asks for the same thing, the brief should not
 * be written from scratch again. Saving one costs a tool call and makes the
 * next one both faster and more like the one that worked.
 */
export default defineTool({
  description:
    "Save how a job that went well was done, so the same request can be briefed the same way next time. Use it after a job the operator was happy with and is likely to ask for again — a weekly check, a report, a routine errand. Saving under an existing name replaces it.",
  inputSchema: z.object({
    name: z.string().min(2).max(60).describe('What the team would call it: "weekly competitor prices".'),
    when: z.string().min(3).max(200).describe("When to reach for it, so you recognise the request next time."),
    jobId: z.string().optional().describe("The job that went well. Its brief and success criteria are kept."),
    brief: z
      .string()
      .max(6_000)
      .optional()
      .describe("The brief to keep, if it should differ from the job's own. Write it for a bot that has never seen this conversation."),
    notes: z
      .array(z.string().max(300))
      .max(8)
      .optional()
      .describe("What went wrong on the way, and what to check. This is what makes the next run better than this one."),
  }),
  label: { start: ({ name }) => `Save recipe: ${name}` },
  async execute(input, ctx) {
    const who = operator(ctx);
    const job = input.jobId === undefined ? null : await getJob(who.workspaceId, input.jobId);
    if (input.jobId !== undefined && job === null) {
      return { saved: false as const, reason: `No job ${input.jobId}.` };
    }
    const brief = input.brief ?? job?.brief ?? "";
    if (brief.trim() === "") {
      return { saved: false as const, reason: "Give a jobId to keep that job's brief, or write the brief to keep." };
    }

    const outcome = await saveRecipe({
      workspaceId: who.workspaceId,
      createdBy: who.label,
      name: input.name,
      when: input.when,
      brief,
      ...(job?.successCriteria ? { successCriteria: job.successCriteria } : {}),
      ...(input.notes ? { notes: input.notes } : {}),
      fromJobId: job?.id ?? null,
      botId: job?.botId ?? null,
    });
    if (!outcome.ok) return { saved: false as const, reason: outcome.error };
    return {
      saved: true as const,
      recipe: { id: outcome.recipe.id, name: outcome.recipe.name, when: outcome.recipe.when },
      next: "Next time this comes up, pass recipe to assign_job instead of writing the brief again.",
    };
  },
});
