import { getBot } from "./bots";
import { listJobs } from "./jobs";
import type { Job } from "./types";
import { gatewayAccount, type GatewayAccount } from "./gateway-account";
import { dayOf, ledgerTotal, NO_USAGE, readLedger, type Usage } from "./usage";

/**
 * The usage page: everything the workspace has spent, cut four ways, plus the
 * jobs that spent it. Built from the ledger and the job records on request;
 * nothing here is stored.
 */
export interface UsageReport {
  readonly total: Usage;
  readonly hq: Usage;
  /** Jev's judgements: Gateway calls that belong to no session, so they are their own line. */
  readonly jev: Usage;
  /** The quick model reading exchanges for memories to keep. */
  readonly memory: Usage;
  /** What Gateway says the whole account has spent, when a key is set and Gateway answers. */
  readonly account: GatewayAccount | null;
  /** Each Bot that has spent anything, biggest spender first. Retired Bots keep their line. */
  readonly bots: readonly { readonly botId: string; readonly name: string; readonly emoji: string | null; readonly retired: boolean; readonly usage: Usage }[];
  /** Each model that ran a step, biggest spender first. */
  readonly models: readonly { readonly model: string; readonly usage: Usage }[];
  /** One entry per day for the last `days` days, oldest first, zeros where nothing ran. */
  readonly days: readonly { readonly day: string; readonly usage: Usage }[];
  /** Jobs that recorded usage, newest first. */
  readonly jobs: readonly {
    readonly id: string;
    readonly title: string;
    readonly botId: string;
    readonly botName: string;
    readonly status: Job["status"];
    readonly at: string;
    readonly usage: Usage;
  }[];
  readonly updatedAt: string;
}

const byCost = (left: { usage: Usage }, right: { usage: Usage }) =>
  right.usage.costUsd - left.usage.costUsd || right.usage.inputTokens + right.usage.outputTokens - (left.usage.inputTokens + left.usage.outputTokens);

export async function usageReport(workspaceId: string, options: { days?: number; jobs?: number; now?: Date } = {}): Promise<UsageReport> {
  const now = options.now ?? new Date();
  const span = options.days ?? 30;
  const [ledger, jobs, account] = await Promise.all([readLedger(workspaceId), listJobs(workspaceId, { limit: 500 }), gatewayAccount()]);

  const botIds = new Set([...Object.keys(ledger.bots), ...jobs.filter((job) => job.usage !== undefined).map((job) => job.botId)]);
  const names = new Map<string, { name: string; emoji: string | null; retired: boolean }>();
  await Promise.all(
    [...botIds].map(async (botId) => {
      const bot = await getBot(workspaceId, botId);
      names.set(botId, bot === null ? { name: "Retired Bot", emoji: null, retired: true } : { name: bot.name, emoji: bot.emoji, retired: false });
    }),
  );
  const nameOf = (botId: string) => names.get(botId) ?? { name: "Retired Bot", emoji: null, retired: true };

  const days: { day: string; usage: Usage }[] = [];
  for (let back = span - 1; back >= 0; back -= 1) {
    const day = dayOf(new Date(now.getTime() - back * 86_400_000));
    days.push({ day, usage: ledger.byDay?.[day] ?? NO_USAGE });
  }

  return {
    total: ledgerTotal(ledger),
    hq: ledger.hq,
    jev: ledger.jev ?? NO_USAGE,
    memory: ledger.memory ?? NO_USAGE,
    account,
    bots: Object.entries(ledger.bots)
      .map(([botId, usage]) => ({ botId, ...nameOf(botId), usage }))
      .sort(byCost),
    models: Object.entries(ledger.byModel ?? {})
      .map(([model, usage]) => ({ model, usage }))
      .sort(byCost),
    days,
    jobs: jobs
      .filter((job): job is Job & { usage: Usage } => job.usage !== undefined && job.usage.steps > 0)
      .slice(0, options.jobs ?? 50)
      .map((job) => ({
        id: job.id,
        title: job.title,
        botId: job.botId,
        botName: nameOf(job.botId).name,
        status: job.status,
        at: job.updatedAt,
        usage: job.usage,
      })),
    updatedAt: ledger.updatedAt,
  };
}
