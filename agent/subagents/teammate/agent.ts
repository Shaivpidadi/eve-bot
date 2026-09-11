import type { ModelMessage } from "ai";
import { defineAgent, defineDynamic } from "eve";

import { effortInBrief, modelForEffort, reasoningLevel } from "../../lib/models";

/** The brief is the first message a teammate receives. */
function briefText(messages: readonly ModelMessage[]): string {
  const first = messages.find((message) => message.role === "user");
  if (first === undefined) return "";
  if (typeof first.content === "string") return first.content;
  return first.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

/**
 * A job keeps the model it started with: prompt caches are per model, and a
 * brief compacted out of the history must not switch it mid-run.
 */
const chosen = new Map<string, string>();
const MAX_REMEMBERED = 500;

/**
 * A teammate: one bot doing one job on the team's computer.
 *
 * It never sees HQ's conversation — everything it needs arrives in the brief,
 * including the job's effort, which picks the model (see `lib/models.ts`).
 * `BOT_TEAMMATE_REASONING` sets reasoning depth for every model, and the cost
 * limit is the backstop for a runaway loop.
 */
export default defineAgent({
  description:
    "Does the actual work of a job end to end: research, browser sessions, files, and drafts. Give it the full brief; it cannot see this conversation.",
  model: defineDynamic({
    events: {
      "turn.started": (_event, ctx) => {
        const remembered = chosen.get(ctx.session.id);
        if (remembered !== undefined) return remembered;
        const model = modelForEffort(effortInBrief(briefText(ctx.messages)));
        if (chosen.size >= MAX_REMEMBERED) chosen.delete(chosen.keys().next().value as string);
        chosen.set(ctx.session.id, model);
        return model;
      },
    },
  }),
  reasoning: reasoningLevel(process.env.BOT_TEAMMATE_REASONING, "medium"),
  compaction: {
    thresholdPercent: 0.75,
  },
  limits: {
    maxTokenCostUsdPerSession: Number(process.env.BOT_JOB_COST_LIMIT_USD ?? 5),
  },
});
