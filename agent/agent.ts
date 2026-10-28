// First: the build's Settings values over the environment, before anything below reads it (see settings/built.ts).
import "./lib/settings/built";
import { defineAgent, defineDynamic } from "eve";

import type { DynamicModelContext } from "eve";

import { enginesOn } from "./lib/engines";
import { contextToSend, customEndpoint, defaultModelFor, endpointModel, gatewaySelection, levelOf, reasoningFor, sessionUsage, withOutputLimit } from "./lib/models";

/**
 * HQ's model on AI Gateway: the workspace's choice in the console (see
 * `lib/model-settings.ts`), else `BOT_HQ_MODEL`, else the default. Chosen once
 * per turn, never per step, so a change in the console applies from the next
 * turn and a turn never switches models halfway. Loaded lazily, so the store
 * stays out of whatever loads this definition.
 */
type HqChoice = { readonly selection: ReturnType<typeof gatewaySelection>; readonly picked: string | null };

async function hqChoice(ctx: DynamicModelContext): Promise<HqChoice> {
  const [{ resolveModel }, { operator }, { effectiveEnv }] = await Promise.all([import("./lib/model-settings"), import("./lib/session"), import("./lib/settings/store")]);
  const workspaceId = operator(ctx).workspaceId;
  const [resolved, env] = await Promise.all([resolveModel(workspaceId, "hq").catch(() => null), effectiveEnv(workspaceId).catch(() => process.env)]);
  // How hard HQ reasons, from Settings; the agent's own setting when none is chosen.
  const level = levelOf(env.BOT_HQ_REASONING);
  if (resolved === null || resolved.source === "default") return { selection: gatewaySelection({ id: defaultModelFor("hq"), level }), picked: null };
  return { selection: gatewaySelection({ id: resolved.id, context: contextToSend(resolved.context), reasoning: resolved.reasoning, level }), picked: resolved.id };
}

/**
 * Chosen once a turn and kept with the session, so every step of the turn runs
 * on the same model, on any instance. A model picked in the console is handed
 * over live with its output limit (see `withOutputLimit`).
 */
const hqOnGateway = defineDynamic(async (ctx: DynamicModelContext) => {
  const choice = await ctx.memo(["model", ctx.turn?.id ?? null], () => hqChoice(ctx));
  if (choice.picked === null) return choice.selection;
  const { listedModel } = await import("./lib/gateway-models");
  return withOutputLimit(choice.selection, await listedModel(choice.picked));
});

/**
 * HQ's model on your own provider: the workspace's choice on the Models page,
 * else `BOT_HQ_MODEL`, else the provider's model. eve evaluates it before every model
 * call, from settings cached for 30 seconds, with the context window eve cannot look up.
 */
const endpoint = customEndpoint();
const hqOnEndpoint = defineDynamic(async (ctx: DynamicModelContext) => {
  const [{ resolveModel }, { operator }] = await Promise.all([import("./lib/model-settings"), import("./lib/session")]);
  const resolved = await resolveModel(operator(ctx).workspaceId, "hq").catch(() => null);
  return { model: endpointModel(endpoint!, resolved?.id ?? defaultModelFor("hq")), modelContextWindowTokens: endpoint!.contextWindowTokens };
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
  model: endpoint === null ? hqOnGateway : hqOnEndpoint,
  ...reasoningFor(process.env.BOT_HQ_REASONING, "low"),
  compaction: {
    thresholdPercent: 0.8,
  },
  // A shared Workflow world (a Postgres one, say) lets a run outlive the process
  // that started it on a self-hosted server. Off unless named; see
  // docs/research/shared-world.md and BOT_WORKFLOW_WORLD in docs/configuration.md.
  experimental: {
    workflow: {
      // Threads and jobs read their transcripts back from their runs, so keep
      // them for the World's default period, as eve did before 0.82 (which now
      // deletes an authenticated session's run data when the session ends).
      retention: "default",
      ...(process.env.BOT_WORKFLOW_WORLD?.trim() ? { world: process.env.BOT_WORKFLOW_WORLD.trim() } : {}),
    },
  },
  // Bots on Claude Code (lib/engines): with BOT_ENGINES on at build,
  // durable-harness ships as a runtime dependency, loaded only when such a job
  // runs. Off (the default), the agent service is built without it.
  ...(enginesOn() ? { build: { externalDependencies: ["durable-harness"] } } : {}),
  limits: {
    // A thread is long-lived by design; cap spend, not lifetime: per window of
    // the session (a person's Continue starts the next). A job's run checks its
    // own window against the job's limit (the teammate's agent.ts). On a custom
    // endpoint, token caps back the USD cap up for unpriced models.
    sessionUsage: sessionUsage("hq", Number(process.env.BOT_HQ_COST_LIMIT_USD ?? 10)),
  },
});
