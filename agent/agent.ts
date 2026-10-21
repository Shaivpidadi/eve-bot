import { defineAgent, defineDynamic } from "eve";

import type { DynamicResolveContext } from "eve";

import { enginesOn } from "./lib/engines";
import { contextToSend, customEndpoint, defaultModelFor, gatewaySelection, hqModel, levelOf, reasoningFor, tokenLimits, withOutputLimit } from "./lib/models";

/**
 * HQ's model on AI Gateway: the workspace's choice in the console (see
 * `lib/model-settings.ts`), else `BOT_HQ_MODEL`, else the default. Chosen once
 * per turn, never per step, so a change in the console applies from the next
 * turn and a turn never switches models halfway. Loaded lazily, so the store
 * stays out of whatever loads this definition.
 */
type HqChoice = { readonly selection: ReturnType<typeof gatewaySelection>; readonly picked: string | null };

async function hqChoice(ctx: DynamicResolveContext): Promise<HqChoice> {
  const [{ resolveModel }, { operator }, { effectiveEnv }] = await Promise.all([import("./lib/model-settings"), import("./lib/session"), import("./lib/settings/store")]);
  const workspaceId = operator(ctx).workspaceId;
  const [resolved, env] = await Promise.all([resolveModel(workspaceId, "hq").catch(() => null), effectiveEnv(workspaceId).catch(() => process.env)]);
  // How hard HQ reasons, from Settings; the agent's own setting when none is chosen.
  const level = levelOf(env.BOT_HQ_REASONING);
  if (resolved === null || resolved.source === "default") return { selection: gatewaySelection({ id: defaultModelFor("hq"), level }), picked: null };
  return { selection: gatewaySelection({ id: resolved.id, context: contextToSend(resolved.context), reasoning: resolved.reasoning, level }), picked: resolved.id };
}

/** Each session's choice for its turn, so its steps run on the same model (on this instance; another one asks again). */
const turns = new Map<string, HqChoice>();
const MAX_TURNS = 500;

const hqOnGateway = defineDynamic({
  events: {
    "turn.started": async (_event, ctx) => {
      const choice = await hqChoice(ctx);
      if (turns.size >= MAX_TURNS) turns.delete(turns.keys().next().value as string);
      turns.set(ctx.session.id, choice);
      return choice.selection;
    },
    // A model picked in the console is handed over live with its output limit (see `withOutputLimit`).
    "step.started": async (_event, ctx) => {
      const choice = turns.get(ctx.session.id) ?? (await hqChoice(ctx));
      if (choice.picked === null) return choice.selection;
      const { listedModel } = await import("./lib/gateway-models");
      return withOutputLimit(choice.selection, await listedModel(choice.picked));
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
  // Bots on Claude Code (lib/engines): with BOT_ENGINES on at build,
  // durable-harness ships as a runtime dependency, loaded only when such a job
  // runs. Off (the default), the agent service is built without it.
  ...(enginesOn() ? { build: { externalDependencies: ["durable-harness"] } } : {}),
  limits: {
    // A thread is long-lived by design; cap spend, not lifetime. Jobs started
    // from a thread draw their budget from what the thread has left, so this
    // stays above a job's own limit.
    maxTokenCostUsdPerSession: Number(process.env.BOT_HQ_COST_LIMIT_USD ?? 10),
    // On a custom endpoint, token caps back the USD cap up for unpriced models.
    ...tokenLimits("hq"),
  },
});
