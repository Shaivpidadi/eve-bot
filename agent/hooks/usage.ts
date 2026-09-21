import { defineHook, type HookContext } from "eve/hooks";

import { sessionState } from "../lib/session-state";
import { operator } from "../lib/session";
import { recordUsage, usageOfStep } from "../lib/usage";

/**
 * What HQ's own turns cost, added to the ledger step by step.
 *
 * `step.started` names the model, `step.completed` carries the usage; the
 * model is remembered per session between the two. Child sessions (a Bot on a
 * job) keep their own books in the teammate's hook. Bookkeeping never takes
 * down a turn, so failures are swallowed.
 */
const models = sessionState<string>();
const isRoot = (ctx: HookContext) => ctx.session.parent === undefined;

export default defineHook({
  events: {
    "step.started"(event, ctx) {
      const modelId = (event.data as { modelId?: unknown }).modelId;
      if (typeof modelId === "string") models.set(ctx.session.id, modelId);
    },
    async "step.completed"(event, ctx) {
      if (!isRoot(ctx)) return;
      try {
        const { workspaceId } = operator(ctx);
        await recordUsage(workspaceId, "hq", usageOfStep(event.data, models.get(ctx.session.id) ?? null));
      } catch {
        // The ledger is a convenience; the turn is not.
      }
    },
  },
});
