import { defineAgent } from "eve";

/**
 * Bot HQ — the teammate you message.
 *
 * HQ routes, delegates, and reports. The actual work happens in the `teammate`
 * subagent, which gets its own computer. Sonnet handles the conversation well
 * and cheaply; swap it if you want HQ to reason harder about delegation.
 */
export default defineAgent({
  model: process.env.BOT_HQ_MODEL ?? "anthropic/claude-sonnet-5",
  reasoning: "medium",
  compaction: {
    thresholdPercent: 0.8,
  },
  limits: {
    // A teammate conversation is long-lived by design; cap spend, not lifetime.
    maxTokenCostUsdPerSession: Number(process.env.BOT_HQ_COST_LIMIT_USD ?? 5),
  },
});
