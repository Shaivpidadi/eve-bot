import type { ModelMessage } from "ai";
import { defineAgent, defineDynamic } from "eve";

import type { DynamicResolveContext } from "eve";

import { customEndpoint, effortInBrief, endpointModel, gatewayModelOptions, type GatewayOptions, modelForEffort, reasoningFor, tokenLimits } from "../../lib/models";

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

function modelFor(ctx: Pick<DynamicResolveContext, "session" | "messages">): string {
  const remembered = chosen.get(ctx.session.id);
  if (remembered !== undefined) return remembered;
  const model = modelForEffort(effortInBrief(briefText(ctx.messages)));
  if (chosen.size >= MAX_REMEMBERED) chosen.delete(chosen.keys().next().value as string);
  chosen.set(ctx.session.id, model);
  return model;
}

/**
 * On Vercel AI Gateway the model is chosen once per turn by name. A custom
 * endpoint's model is a live object, which eve accepts only per model step, so
 * it is chosen there, with the context window eve cannot look up.
 */
const endpoint = customEndpoint();

/**
 * A run that was cancelled or halted by the budget makes no further model
 * call, compaction included: eve resolves the model for a step before it
 * compacts a long history, and a throw here fails that step (the `fence` and
 * `usage` hooks stop the model request itself, after compaction). Loaded
 * lazily, so the store stays out of whatever loads the agent's definition.
 */
async function refuseStoppedRun(event: unknown, ctx: DynamicResolveContext): Promise<void> {
  const [{ stepOf, stopReason }, { operator }] = await Promise.all([import("./lib/stops"), import("../../lib/session")]);
  const reason = await stopReason(ctx.session.id, () => operator(ctx).workspaceId, stepOf((event as { data?: unknown } | null)?.data));
  if (reason !== null) throw new Error(reason);
}

/**
 * A teammate: one bot doing one job on the team's computer.
 *
 * It never sees HQ's conversation — everything it needs arrives in the brief,
 * including the job's effort, which picks the model (see `lib/models.ts`).
 * `BOT_TEAMMATE_REASONING` sets reasoning depth for every model, and the cost
 * limit is the backstop for a runaway loop.
 */
/** The job's model, with AI Gateway's data controls when any are set (see `gatewayOptions`). */
function selection(model: string): string | { readonly model: string; readonly modelOptions?: { readonly providerOptions: GatewayOptions } } {
  const options = gatewayModelOptions();
  return options.modelOptions === undefined ? model : { model, ...options };
}

export default defineAgent({
  description:
    "Does the actual work of a job end to end: research, browser sessions, files, and drafts. Give it the full brief; it cannot see this conversation.",
  model: defineDynamic({
    events:
      endpoint === null
        ? {
            "turn.started": (_event, ctx) => selection(modelFor(ctx)),
            "step.started": async (event, ctx) => {
              await refuseStoppedRun(event, ctx);
              return selection(modelFor(ctx));
            },
          }
        : {
            "step.started": async (event, ctx) => {
              await refuseStoppedRun(event, ctx);
              return { model: endpointModel(endpoint, modelFor(ctx)), modelContextWindowTokens: endpoint.contextWindowTokens };
            },
          },
  }),
  ...reasoningFor(process.env.BOT_TEAMMATE_REASONING, "medium"),
  compaction: {
    thresholdPercent: 0.75,
  },
  limits: {
    maxTokenCostUsdPerSession: Number(process.env.BOT_JOB_COST_LIMIT_USD ?? 5),
    // On a custom endpoint, token caps back the USD cap up for unpriced models.
    ...tokenLimits("job"),
  },
});
