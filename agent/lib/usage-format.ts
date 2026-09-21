/**
 * Usage as a person reads it. Pure, so the console can import it too.
 */
export interface UsageLike {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly costUsd: number;
  readonly steps: number;
  readonly models: Readonly<Record<string, number>>;
}

/** Tokens as a person reads them: 1.2k, 340k, 2.1M. */
export const tokens = (count: number): string =>
  count >= 1_000_000 ? `${(count / 1_000_000).toFixed(1)}M` : count >= 1_000 ? `${(count / 1_000).toFixed(count >= 100_000 ? 0 : 1)}k` : String(count);

/** Dollars, to the cent above a cent and to the tenth of a cent below. */
export const usd = (cost: number): string => (cost >= 0.01 ? `$${cost.toFixed(2)}` : cost > 0 ? `$${cost.toFixed(3)}` : "$0");

/** The model a record ran on, or how many when it ran on several. */
export const modelsOf = (usage: UsageLike): string | null => {
  const names = Object.keys(usage.models);
  return names.length === 1 ? (names[0] ?? null) : names.length > 1 ? `${names.length} models` : null;
};

/** One line about what a job or thread spent, or null when nothing was recorded. */
export function describeUsage(usage: UsageLike | undefined): string | null {
  if (usage === undefined || usage.steps === 0) return null;
  const parts = [`${tokens(usage.inputTokens + usage.outputTokens)} tokens`, usd(usage.costUsd)];
  const model = modelsOf(usage);
  return (model === null ? parts : [model, ...parts]).join(" · ");
}
