import { defineAgent } from "eve";

import { reasoningLevel } from "./lib/models";

/**
 * Bot HQ — the teammate you message.
 *
 * HQ routes, delegates, and reports. The actual work happens in the `teammate`
 * subagent, on a model picked per job (see `lib/models.ts`). Sonnet handles the
 * conversation well and cheaply, and light reasoning is enough to write a brief.
 */
export default defineAgent({
  model: process.env.BOT_HQ_MODEL ?? "anthropic/claude-sonnet-5",
  reasoning: reasoningLevel(process.env.BOT_HQ_REASONING, "low"),
  compaction: {
    thresholdPercent: 0.8,
  },
  limits: {
    // A thread is long-lived by design; cap spend, not lifetime. Jobs started
    // from a thread draw their budget from what the thread has left, so this
    // stays above a job's own limit.
    maxTokenCostUsdPerSession: Number(process.env.BOT_HQ_COST_LIMIT_USD ?? 10),
  },
});
