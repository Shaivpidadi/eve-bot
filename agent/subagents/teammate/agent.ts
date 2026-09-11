import { defineAgent } from "eve";

/**
 * A teammate: one bot doing one job on its own computer.
 *
 * It never sees HQ's conversation — everything it needs arrives in the brief.
 * This is the agent that actually finishes work, so it gets the stronger model
 * and a long leash; the cost limit is the backstop for a runaway loop.
 */
export default defineAgent({
  description:
    "Does the actual work of a job end to end: research, browser sessions, files, and drafts. Give it the full brief; it cannot see this conversation.",
  model: process.env.BOT_TEAMMATE_MODEL ?? "anthropic/claude-opus-5",
  reasoning: "high",
  compaction: {
    thresholdPercent: 0.75,
  },
  limits: {
    maxTokenCostUsdPerSession: Number(process.env.BOT_JOB_COST_LIMIT_USD ?? 10),
  },
});
