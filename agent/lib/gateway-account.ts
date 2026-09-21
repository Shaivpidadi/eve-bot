/**
 * The AI Gateway account behind the workspace, as Gateway itself reports it:
 * credit left, and everything ever spent on this key across every project.
 *
 * This is the figure to reconcile the usage page against. It is wider than
 * the page (other projects, other deployments, calls eve makes that are not a
 * model step) and it is never narrower, so the page's total should only ever
 * be at or below it.
 */
export interface GatewayAccount {
  readonly balanceUsd: number;
  readonly totalUsedUsd: number;
  readonly at: string;
}

const CREDITS_URL = "https://ai-gateway.vercel.sh/v1/credits";
const CACHE_MS = 60_000;

let cached: { readonly account: GatewayAccount | null; readonly until: number } | undefined;

const money = (value: unknown): number | null => {
  const parsed = typeof value === "string" || typeof value === "number" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
};

/** Null without a Gateway key, and null (for a minute) when Gateway does not answer. */
export async function gatewayAccount(fetcher: typeof fetch = fetch): Promise<GatewayAccount | null> {
  const key = (process.env.AI_GATEWAY_API_KEY ?? "").trim();
  if (key === "") return null;
  if (cached !== undefined && cached.until > Date.now()) return cached.account;
  let account: GatewayAccount | null = null;
  try {
    const response = await fetcher(CREDITS_URL, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(4_000) });
    const body: unknown = response.ok ? await response.json() : null;
    const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
    const balance = money(record.balance);
    const used = money(record.total_used);
    if (balance !== null && used !== null) account = { balanceUsd: balance, totalUsedUsd: used, at: new Date().toISOString() };
  } catch {
    // The page shows its own ledger either way.
  }
  cached = { account, until: Date.now() + CACHE_MS };
  return account;
}

/** For tests. */
export function forgetGatewayAccount(): void {
  cached = undefined;
}
