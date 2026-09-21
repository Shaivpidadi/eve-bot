import { readDoc, updateDoc } from "./store";

/**
 * What the models cost, by who spent it.
 *
 * eve reports usage on every model step; nothing kept it. This is the ledger:
 * one record per workspace with HQ's own spend and each Bot's, and a copy on
 * each job of what that job cost. Tokens are counted as the provider counted
 * them, cost as eve priced it (AI Gateway's figure, or `pricing.ts` on a
 * custom endpoint). Where a provider reports no cost, tokens still add up.
 */
export type { UsageLike } from "./usage-format";

export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  /** Tokens written to the provider's prompt cache; billed, and counted in Gateway's token totals. */
  readonly cacheWriteTokens: number;
  readonly costUsd: number;
  /** Model steps counted. */
  readonly steps: number;
  /** Steps per model id, so a thread can say which models it ran on. */
  readonly models: Readonly<Record<string, number>>;
}

export const NO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, steps: 0, models: {} };

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** The usage one `step.completed` event reports, as this ledger counts it. */
export function usageOfStep(data: unknown, modelId: string | null): Usage {
  const raw = (data as { usage?: Record<string, unknown> } | null)?.usage ?? {};
  return {
    inputTokens: num(raw.inputTokens),
    outputTokens: num(raw.outputTokens),
    cacheReadTokens: num(raw.cacheReadTokens),
    cacheWriteTokens: num(raw.cacheWriteTokens),
    costUsd: num(raw.costUsd),
    steps: 1,
    models: modelId === null ? {} : { [modelId]: 1 },
  };
}

export function addUsage(left: Usage | undefined, right: Usage): Usage {
  // Records written before cache writes were kept read as zero there.
  const base = { ...NO_USAGE, ...left };
  const models: Record<string, number> = { ...base.models };
  for (const [model, steps] of Object.entries(right.models)) models[model] = (models[model] ?? 0) + steps;
  return {
    inputTokens: base.inputTokens + right.inputTokens,
    outputTokens: base.outputTokens + right.outputTokens,
    cacheReadTokens: base.cacheReadTokens + right.cacheReadTokens,
    cacheWriteTokens: base.cacheWriteTokens + num(right.cacheWriteTokens),
    costUsd: Math.round((base.costUsd + right.costUsd) * 1e6) / 1e6,
    steps: base.steps + right.steps,
    models,
  };
}

/** The ledger: HQ's spend and each Bot's, for the whole workspace's life. */
export interface UsageLedger {
  readonly hq: Usage;
  readonly bots: Readonly<Record<string, Usage>>;
  /** Jev's second opinions, which are Gateway calls but not steps of any session. Absent on older ledgers. */
  readonly jev?: Usage;
  /** The same spend, by the model that ran the step. Absent on ledgers written before it was kept. */
  readonly byModel?: Readonly<Record<string, Usage>>;
  /** The same spend, by UTC day (`YYYY-MM-DD`), for the last `DAYS_KEPT` days. */
  readonly byDay?: Readonly<Record<string, Usage>>;
  readonly updatedAt: string;
}

export const EMPTY_LEDGER: UsageLedger = { hq: NO_USAGE, bots: {}, jev: NO_USAGE, byModel: {}, byDay: {}, updatedAt: "" };

/** Who spent it: HQ's own turns, Jev's judgements, or a Bot by id. */
export type UsageScope = "hq" | "jev" | { readonly botId: string };

/** How many days of daily figures the ledger keeps; the all-time totals never expire. */
export const DAYS_KEPT = 90;

/** How the ledger names a step whose model eve did not report. */
export const UNREPORTED_MODEL = "model not reported";

const key = (workspaceId: string) => `usage/${workspaceId}.json`;

/** A UTC calendar day, the unit the daily figures are kept in. */
export const dayOf = (at: Date): string => at.toISOString().slice(0, 10);

export async function readLedger(workspaceId: string): Promise<UsageLedger> {
  return (await readDoc<UsageLedger>(key(workspaceId)))?.value ?? EMPTY_LEDGER;
}

/**
 * One step, added to the ledger: to HQ (`scope: "hq"`) or to a Bot by id,
 * and to the model and the day it ran on. Days older than `DAYS_KEPT` fall off
 * as new ones are written.
 */
export function addToLedger(current: UsageLedger | null, scope: UsageScope, usage: Usage, at: Date = new Date()): UsageLedger {
  const ledger = current ?? EMPTY_LEDGER;
  const byModel: Record<string, Usage> = { ...ledger.byModel };
  const modelNames = Object.keys(usage.models);
  for (const model of modelNames.length === 0 ? [UNREPORTED_MODEL] : modelNames) byModel[model] = addUsage(byModel[model], usage);

  const day = dayOf(at);
  const oldest = dayOf(new Date(at.getTime() - DAYS_KEPT * 86_400_000));
  const byDay: Record<string, Usage> = {};
  for (const [kept, spent] of Object.entries(ledger.byDay ?? {})) if (kept >= oldest) byDay[kept] = spent;
  byDay[day] = addUsage(byDay[day], usage);

  return {
    hq: scope === "hq" ? addUsage(ledger.hq, usage) : ledger.hq,
    jev: scope === "jev" ? addUsage(ledger.jev, usage) : (ledger.jev ?? NO_USAGE),
    bots: typeof scope === "string" ? ledger.bots : { ...ledger.bots, [scope.botId]: addUsage(ledger.bots[scope.botId], usage) },
    byModel,
    byDay,
    updatedAt: at.toISOString(),
  };
}

/** Everything on the ledger added up: HQ, every Bot, and Jev. */
export const ledgerTotal = (ledger: UsageLedger): Usage =>
  Object.values(ledger.bots).reduce((sum, usage) => addUsage(sum, usage), addUsage(ledger.hq, ledger.jev ?? NO_USAGE));

/** Adds one step's usage to the workspace's ledger. */
export async function recordUsage(workspaceId: string, scope: UsageScope, usage: Usage): Promise<void> {
  await updateDoc<UsageLedger>(key(workspaceId), (current) => addToLedger(current, scope, usage));
}

export { describeUsage, modelsOf, tokens, usd } from "./usage-format";
