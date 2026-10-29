import { defineHook, type HookContext } from "eve/hooks";

import { operator } from "../lib/session";
import { chargeUsage } from "../lib/spend";
import { ownSpend, stepCostReported, usageOfStep } from "../lib/usage";

/**
 * What HQ's own turns cost, added to the ledger as eve records it.
 *
 * eve records each model run's spend as `usage.recorded`, owned by the run
 * (whose model the session view names) or by a compaction. Spend a delegated
 * call reports for the agent it called is left out: a Bot on a job keeps its
 * own books in the teammate's hook. HQ's spend draws on the workspace budget
 * with no reservation of its own (HQ is not admitted step by step; its
 * per-session cap bounds a thread), so it leaves less for the runs the budget
 * does admit. Bookkeeping never takes down a turn, so failures are swallowed.
 */
const isRoot = (ctx: HookContext) => ctx.session.parent === undefined;

export default defineHook({
  events: {
    async "usage.recorded"(event, ctx) {
      if (!isRoot(ctx)) return;
      const spent = ownSpend(event.data, ctx.view);
      if (spent === null) return;
      try {
        const { workspaceId } = operator(ctx);
        await chargeUsage(workspaceId, "hq", usageOfStep(event.data, spent.modelId), {
          costReported: stepCostReported(event.data),
          id: `${ctx.session.id}:${ctx.position.line}:${ctx.position.index}`,
        });
      } catch {
        // The ledger is a convenience; the turn is not.
      }
    },
  },
});
