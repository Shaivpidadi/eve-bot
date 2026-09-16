import { defineAgent } from "eve";

import { hqModel, reasoningFor, tokenLimits } from "./lib/models";

/**
 * Bot HQ — the teammate you message.
 *
 * HQ routes, delegates, and reports. The actual work happens in the `teammate`
 * subagent, on a model picked per job (see `lib/models.ts`). Sonnet handles the
 * conversation well and cheaply, and light reasoning is enough to write a brief.
 * With `BOT_MODEL_BASE_URL` set, HQ runs on that endpoint's model instead.
 */
export default defineAgent({
  ...hqModel(),
  ...reasoningFor(process.env.BOT_HQ_REASONING, "low"),
  compaction: {
    thresholdPercent: 0.8,
  },
  limits: {
    // A thread is long-lived by design; cap spend, not lifetime. Jobs started
    // from a thread draw their budget from what the thread has left, so this
    // stays above a job's own limit.
    maxTokenCostUsdPerSession: Number(process.env.BOT_HQ_COST_LIMIT_USD ?? 10),
    // On a custom endpoint, token caps back the USD cap up for unpriced models.
    ...tokenLimits("hq"),
  },
});
