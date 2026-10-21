// First: the build's Settings values over the environment, before anything below reads it (see settings/built.ts).
import "../../lib/settings/built";
import type { ModelMessage } from "ai";
import { defineAgent, defineDynamic } from "eve";

import type { DynamicResolveContext } from "eve";

import { customEndpoint, effortInBrief, endpointModel, gatewaySelection, modelForEffort, modelInBrief, type ReasoningLevel, reasoningFor, sessionUsage, withOutputLimit } from "../../lib/models";

const textOf = (message: ModelMessage): string =>
  typeof message.content === "string" ? message.content : Array.isArray(message.content) ? message.content.map((part) => (part.type === "text" ? part.text : "")).join("\n") : "";

/**
 * The brief `run_job` sent (see `renderBrief`): the user message with the
 * job's section. Not simply the first: eve puts memory and other instructions
 * ahead of it as user messages too.
 */
export function briefText(messages: readonly ModelMessage[]): string {
  const users = messages.filter((message) => message.role === "user").map(textOf);
  return users.find((text) => /^## Job$/m.test(text)) ?? users.at(-1) ?? "";
}

type Chosen = {
  readonly id: string;
  readonly context: number | null;
  readonly reasoning: boolean | null;
  readonly level?: ReasoningLevel | null;
  /** Picked in the console (the brief names it), rather than by the job's effort. */
  readonly picked?: boolean;
};

/**
 * A job keeps the model it started with: prompt caches are per model, and a
 * brief compacted out of the history must not switch it mid-run. The brief
 * names it (`run_job` writes the workspace's choice there, see
 * `model-settings.ts`), so every step agrees on any instance; a brief from
 * before that, or on a custom endpoint, picks by its effort as before.
 */
const chosen = new Map<string, Chosen>();
const MAX_REMEMBERED = 500;

function modelFor(ctx: Pick<DynamicResolveContext, "session" | "messages">): Chosen {
  const remembered = chosen.get(ctx.session.id);
  if (remembered !== undefined) return remembered;
  const brief = briefText(ctx.messages);
  const named = endpoint === null ? modelInBrief(brief) : null;
  const model: Chosen = named === null ? { id: modelForEffort(effortInBrief(brief)), context: null, reasoning: null } : { ...named, picked: true };
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
/** The job's model, with AI Gateway's data controls and what eve cannot look up itself (see `gatewaySelection`). */
const selection = (model: Chosen) => gatewaySelection(model);

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
              const model = modelFor(ctx);
              if (model.picked !== true) return selection(model);
              // A model picked in the console is handed over live with its output limit (see `withOutputLimit`).
              const { listedModel } = await import("../../lib/gateway-models");
              return withOutputLimit(selection(model), await listedModel(model.id));
            },
          }
        : {
            "step.started": async (event, ctx) => {
              await refuseStoppedRun(event, ctx);
              return { model: endpointModel(endpoint, modelFor(ctx).id), modelContextWindowTokens: endpoint.contextWindowTokens };
            },
          },
  }),
  ...reasoningFor(process.env.BOT_TEAMMATE_REASONING, "medium"),
  compaction: {
    thresholdPercent: 0.75,
  },
  // A job's run keeps its transcript too, as HQ's does (see agent/agent.ts).
  experimental: { workflow: { retention: "default" } },
  limits: {
    // Spend per window of the session; on a custom endpoint, token caps back the USD cap up for unpriced models.
    sessionUsage: sessionUsage("job", Number(process.env.BOT_JOB_COST_LIMIT_USD ?? 5)),
  },
});
