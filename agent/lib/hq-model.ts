import { autoModel } from "eve/experimental/evaluate";

import { jevModel, jevOn } from "./jev";
import { customEndpoint, hqModel as endpointHqModel, modelForEffort } from "./models";

/**
 * HQ's model: a choice made per turn, or one model.
 *
 * Most of what HQ does is conversation and routing, which the standard model
 * handles well and cheaply. Some turns are not: planning a hard job, untangling
 * an unclear request. With Jev on, eve's `autoModel` has it read the recent
 * messages at the start of each turn and pick between the team's standard
 * model and its deep one, the same two a job's effort picks between. Jev is a
 * small decision model: fast, cheap, and it never sees credentials, only the
 * option descriptions. The whole turn, tools included, then runs on the model
 * it chose.
 *
 * `BOT_HQ_MODEL` pins one model and skips the choice; `BOT_JEV=off` does too, and so
 * does a custom model endpoint (`BOT_MODEL_BASE_URL`): `autoModel` routes between
 * Gateway model ids, and an endpoint's models are live objects it cannot route to.
 * The other Jev decisions (effort, Bot, browser pilot) still run there when Jev is on.
 *
 * This lives apart from `models.ts` on purpose: `run_job` imports that module
 * into its workflow bundle, and `autoModel` needs Node APIs the bundle forbids.
 * Only `agent/agent.ts` imports this file.
 */

const ROUTES = {
  routine: {
    effort: "standard" as const,
    reasoning: "low" as const,
    description:
      "Conversation and coordination: greetings, status questions, relaying a result, answering from what is already known, or assigning routine work whose brief is clear from the request.",
  },
  hard: {
    effort: "deep" as const,
    reasoning: "medium" as const,
    description:
      "Requests that take judgment: ambiguous or conflicting instructions, planning multi-step or high-stakes work, weighing trade-offs, anything irreversible or expensive, or a brief that needs real thought to get right.",
  },
} as const;

export function hqModel(): ReturnType<typeof endpointHqModel> | { readonly model: ReturnType<typeof autoModel> } {
  // A custom endpoint runs HQ on its own model; autoModel cannot route to it.
  if (customEndpoint() !== null) return endpointHqModel();
  const pinned = process.env.BOT_HQ_MODEL?.trim();
  if (pinned) return { model: pinned };
  if (!jevOn()) return { model: modelForEffort("standard") };

  const options = Object.fromEntries(
    Object.entries(ROUTES).map(([key, route]) => [
      key,
      { model: modelForEffort(route.effort), description: route.description, reasoning: route.reasoning },
    ]),
  );
  return { model: autoModel({ model: jevModel(), options }) };
}
