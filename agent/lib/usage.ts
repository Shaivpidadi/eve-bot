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
  readonly costUsd: number;
  /** Model steps counted. */
  readonly steps: number;
  /** Steps per model id, so a thread can say which models it ran on. */
  readonly models: Readonly<Record<string, number>>;
}

export const NO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0, steps: 0, models: {} };

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** The usage one `step.completed` event reports, as this ledger counts it. */
export function usageOfStep(data: unknown, modelId: string | null): Usage {
  const raw = (data as { usage?: Record<string, unknown> } | null)?.usage ?? {};
  return {
    inputTokens: num(raw.inputTokens),
    outputTokens: num(raw.outputTokens),
    cacheReadTokens: num(raw.cacheReadTokens),
    costUsd: num(raw.costUsd),
    steps: 1,
    models: modelId === null ? {} : { [modelId]: 1 },
  };
}

export function addUsage(left: Usage | undefined, right: Usage): Usage {
  const base = left ?? NO_USAGE;
  const models: Record<string, number> = { ...base.models };
  for (const [model, steps] of Object.entries(right.models)) models[model] = (models[model] ?? 0) + steps;
  return {
    inputTokens: base.inputTokens + right.inputTokens,
    outputTokens: base.outputTokens + right.outputTokens,
    cacheReadTokens: base.cacheReadTokens + right.cacheReadTokens,
    costUsd: Math.round((base.costUsd + right.costUsd) * 1e6) / 1e6,
    steps: base.steps + right.steps,
    models,
  };
}

/** The ledger: HQ's spend and each Bot's, for the whole workspace's life. */
export interface UsageLedger {
  readonly hq: Usage;
  readonly bots: Readonly<Record<string, Usage>>;
  readonly updatedAt: string;
}

const key = (workspaceId: string) => `usage/${workspaceId}.json`;

export async function readLedger(workspaceId: string): Promise<UsageLedger> {
  return (await readDoc<UsageLedger>(key(workspaceId)))?.value ?? { hq: NO_USAGE, bots: {}, updatedAt: "" };
}

/** Adds one step's usage to HQ (`scope: "hq"`) or to a Bot by id. */
export async function recordUsage(workspaceId: string, scope: "hq" | { botId: string }, usage: Usage): Promise<void> {
  await updateDoc<UsageLedger>(key(workspaceId), (current) => {
    const ledger = current ?? { hq: NO_USAGE, bots: {}, updatedAt: "" };
    return {
      hq: scope === "hq" ? addUsage(ledger.hq, usage) : ledger.hq,
      bots: scope === "hq" ? ledger.bots : { ...ledger.bots, [scope.botId]: addUsage(ledger.bots[scope.botId], usage) },
      updatedAt: new Date().toISOString(),
    };
  });
}

export { describeUsage, modelsOf, tokens, usd } from "./usage-format";
