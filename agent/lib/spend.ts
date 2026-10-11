import { recordSpend, type SpendCategory, type SpendOutcome } from "./budget";
import { recordUsage, type Usage, type UsageScope } from "./usage";

/**
 * Where every model call's cost goes: the usage ledger (what was spent, by
 * whom, for the usage page) and the workspace budget (what may still be
 * spent, see `budget.ts`). Every caller that used to write only the ledger
 * comes through here: HQ's steps and each Bot's (the usage hooks), Jev's
 * judgements, memory extraction and embeddings. So an auxiliary call made
 * outside any session draws on the same budget as the runs do, against a
 * run's reservation when the caller knows the run, else the workspace's.
 */

const categoryOf = (scope: UsageScope): SpendCategory => (typeof scope === "string" ? scope : "job");

/** The cost a call's provider metadata reports (AI Gateway, or `pricing.ts`), or null when none did. */
export function reportedCost(metadata: unknown): number | null {
  const cost = (metadata as { gateway?: { cost?: unknown } } | null | undefined)?.gateway?.cost;
  const value = typeof cost === "string" || typeof cost === "number" ? Number(cost) : NaN;
  return Number.isFinite(value) ? value : null;
}

export interface Charge {
  /** The run whose reservation this spend draws on; absent or null for workspace-level spend. */
  readonly runToken?: string | null;
  /**
   * Whether anything priced the call. False when the provider reported no
   * cost: the budget then counts it as unknown instead of as free.
   */
  readonly costReported: boolean;
  /** An id unique to this call (a hook event's id), so a re-delivery is counted once. */
  readonly id?: string;
}

/**
 * Adds one call's usage to the ledger and its cost to the budget. Throws only
 * if the ledger write fails (callers already treat that as best effort); the
 * budget half never throws and says whether the run must stop (`halted`).
 */
export async function chargeUsage(workspaceId: string, scope: UsageScope, usage: Usage, charge: Charge): Promise<SpendOutcome> {
  const [ledger, spend] = await Promise.allSettled([
    recordUsage(workspaceId, scope, usage),
    recordSpend(workspaceId, charge.runToken ?? null, charge.costReported ? usage.costUsd : null, categoryOf(scope), {
      ...(charge.id === undefined ? {} : { id: charge.id }),
    }),
  ]);
  if (ledger.status === "rejected") throw ledger.reason;
  return spend.status === "fulfilled" ? spend.value : { counted: false, halted: false };
}
