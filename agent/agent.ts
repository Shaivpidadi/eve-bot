import { defineAgent, defineDynamic } from "eve";

import { customEndpoint, defaultModelFor, gatewaySelection, hqModel, reasoningFor, tokenLimits, UNLISTED_CONTEXT_TOKENS } from "./lib/models";

/**
 * HQ's model on AI Gateway: the workspace's choice in the console (see
 * `lib/model-settings.ts`), else `BOT_HQ_MODEL`, else the default. Chosen once
 * per turn, never per step, so a change in the console applies from the next
 * turn and a turn never switches models halfway. Loaded lazily, so the store
 * stays out of whatever loads this definition.
 */
const hqOnGateway = defineDynamic({
  events: {
    "turn.started": async (_event, ctx) => {
      const [{ resolveModel }, { operator }] = await Promise.all([import("./lib/model-settings"), import("./lib/session")]);
      const resolved = await resolveModel(operator(ctx).workspaceId, "hq").catch(() => null);
      if (resolved === null || resolved.source === "default") return gatewaySelection({ id: defaultModelFor("hq") });
      return gatewaySelection({ id: resolved.id, context: resolved.context ?? UNLISTED_CONTEXT_TOKENS, reasoning: resolved.reasoning });
    },
  },
});

/**
 * Bot HQ — the teammate you message.
 *
 * HQ routes, delegates, and reports. The actual work happens in the `teammate`
 * subagent, on a model picked per job (see `lib/models.ts`). Sonnet handles the
 * conversation well and cheaply, and light reasoning is enough to write a
 * brief; the console's Models page or `BOT_HQ_MODEL` picks another. With
 * `BOT_MODEL_BASE_URL` set, HQ runs on that endpoint's model instead.
 */
export default defineAgent({
  ...(customEndpoint() === null ? { model: hqOnGateway } : hqModel()),
  ...reasoningFor(process.env.BOT_HQ_REASONING, "low"),
  compaction: {
    thresholdPercent: 0.8,
  },
  // A shared Workflow world (a Postgres one, say) lets a run outlive the process
  // that started it on a self-hosted server. Off unless named; see
  // docs/research/shared-world.md and BOT_WORKFLOW_WORLD in docs/configuration.md.
  ...(process.env.BOT_WORKFLOW_WORLD?.trim()
    ? { experimental: { workflow: { world: process.env.BOT_WORKFLOW_WORLD.trim() } } }
    : {}),
  limits: {
    // A thread is long-lived by design; cap spend, not lifetime. Jobs started
    // from a thread draw their budget from what the thread has left, so this
    // stays above a job's own limit.
    maxTokenCostUsdPerSession: Number(process.env.BOT_HQ_COST_LIMIT_USD ?? 10),
    // On a custom endpoint, token caps back the USD cap up for unpriced models.
    ...tokenLimits("hq"),
  },
});
