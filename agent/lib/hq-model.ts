import { autoModel } from "eve/experimental/evaluate";

import { customEndpoint, hqModel as endpointHqModel } from "./models";

/**
 * HQ's model: one model, or a choice made per turn.
 *
 * Most of what HQ does is conversation and routing, which Sonnet handles well
 * and cheaply. Some turns are not: planning a hard job, untangling an unclear
 * request. `BOT_HQ_ROUTER=jev` has TypeSafe's Jev, through eve's experimental
 * `autoModel`, read the recent messages at the start of each turn and pick
 * between a routine model and a capable one. Jev is a small decision model:
 * fast, cheap, and it never sees credentials, only the option descriptions.
 * The whole turn, tools included, then runs on the model it chose.
 *
 * Off by default while Jev is in early access on AI Gateway. `BOT_HQ_MODEL`
 * pins one model and turns routing off; `BOT_HQ_ROUTER` may also name another
 * AI SDK evaluation model available through the Gateway.
 *
 * This lives apart from `models.ts` on purpose: `run_job` imports that module
 * into its workflow bundle, and `autoModel` needs Node APIs the bundle forbids.
 * Only `agent/agent.ts` imports this file.
 */

const HQ_DEFAULT_MODEL = "anthropic/claude-sonnet-5";

/**
 * The two models HQ may route between, and what each is for. The evaluator
 * reads only these keys and descriptions, plus the recent messages.
 */
const HQ_ROUTES = {
  routine: {
    env: "BOT_HQ_MODEL_ROUTINE",
    model: HQ_DEFAULT_MODEL,
    reasoning: "low" as const,
    description:
      "Conversation and coordination: greetings, status questions, relaying a result, answering from what is already known, or assigning routine work whose brief is clear from the request.",
  },
  hard: {
    env: "BOT_HQ_MODEL_HARD",
    model: "anthropic/claude-opus-5",
    reasoning: "medium" as const,
    description:
      "Requests that take judgment: ambiguous or conflicting instructions, planning multi-step or high-stakes work, weighing trade-offs, anything irreversible or expensive, or a brief that needs real thought to get right.",
  },
} as const;

const OFF = new Set(["", "off", "0", "false"]);
const JEV = new Set(["jev", "1", "on", "true"]);

export function hqModel(): ReturnType<typeof endpointHqModel> | { readonly model: ReturnType<typeof autoModel> } {
  // Jev lives on AI Gateway; a custom endpoint runs HQ on its own model.
  if (customEndpoint() !== null) return endpointHqModel();
  const pinned = process.env.BOT_HQ_MODEL?.trim();
  if (pinned) return { model: pinned };
  const router = process.env.BOT_HQ_ROUTER?.trim().toLowerCase() ?? "";
  if (OFF.has(router)) return { model: HQ_DEFAULT_MODEL };

  const evaluator = JEV.has(router) ? "typesafe-ai/jev" : router;
  const options = Object.fromEntries(
    Object.entries(HQ_ROUTES).map(([key, route]) => [
      key,
      {
        model: process.env[route.env]?.trim() || route.model,
        description: route.description,
        reasoning: route.reasoning,
      },
    ]),
  );
  return { model: autoModel({ model: evaluator, options }) };
}
