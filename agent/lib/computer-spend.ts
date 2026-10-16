import { Sandbox as VercelSandbox } from "@vercel/sandbox";

import { periodOf, recordComputerSessions, type ComputerCharge } from "./budget";
import { computerMode, vercelCredentialsError } from "./computer-config";
import { machineName } from "./machine";
import { computerRates, computerSessionCost } from "./pricing";

/**
 * Charges the team's computer to the workspace budget.
 *
 * The app never sees the computer start or stop: eve resumes the Vercel
 * Sandbox on demand and Vercel stops it when it idles out. What Vercel does
 * keep is a record of every session (each time the VM ran) with its wall-clock
 * duration, its active CPU once it stopped, and its memory. So the charge is a
 * sweep: list the sessions that finished, price each (`pricing.ts`), and
 * charge each once, keyed by its session id (`recordComputerSessions`). A
 * session still running is charged by the first sweep after it stops.
 *
 * Only the Vercel computer is charged; a local one (Docker, a VM) costs this
 * deployment nothing per hour that anyone bills.
 */

/** A session as `Sandbox.listSessions` reports it; only what the charge reads. */
export interface SessionRecord {
  readonly id: string;
  readonly status: string;
  readonly memory: number;
  readonly createdAt: number;
  readonly startedAt?: number | undefined;
  readonly stoppedAt?: number | undefined;
  readonly abortedAt?: number | undefined;
  readonly duration?: number | undefined;
  readonly activeCpuDurationMs?: number | undefined;
}

const FINISHED = new Set(["stopped", "failed", "aborted"]);

/** A session created this long before the window may still have stopped inside it. */
const LONGEST_SESSION_MS = 24 * 60 * 60_000;

/** The deployment's workspace: the one every session falls back to (`session.ts`). */
const workspace = () => process.env.BOT_DEFAULT_WORKSPACE ?? "default";

/** The start of last month (UTC): sessions that stopped before it are left alone. */
function windowStart(now: Date): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1);
}

/** What one finished session is charged, or null when it has not finished. */
export function chargeFor(session: SessionRecord, rates = computerRates()): ComputerCharge | null {
  if (!FINISHED.has(session.status)) return null;
  const stoppedAt = session.stoppedAt ?? session.abortedAt;
  if (stoppedAt === undefined) return null;
  const durationMs =
    session.duration ?? (session.startedAt === undefined ? undefined : Math.max(0, stoppedAt - session.startedAt));
  const usd = computerSessionCost(
    { id: session.id, durationMs, activeCpuMs: session.activeCpuDurationMs, memoryMb: session.memory },
    rates,
  );
  return { sessionId: session.id, usd, stoppedAt: new Date(stoppedAt) };
}

/** The computer's sessions, newest first; nothing when it does not exist yet. */
async function* vercelSessions(): AsyncIterable<SessionRecord> {
  let sandbox: VercelSandbox;
  try {
    sandbox = await VercelSandbox.get({ name: await machineName() });
  } catch (error) {
    const status = (error as { response?: { status?: number } } | null)?.response?.status;
    if (status === 404 || /\b404\b|not found/i.test(error instanceof Error ? error.message : String(error))) return;
    throw error;
  }
  yield* await sandbox.listSessions({ sortOrder: "desc" });
}

/**
 * Charges every computer session that finished since the start of last month
 * and is not charged yet. Returns how many this call charged. Never wakes the
 * computer. `sessions` replaces the Vercel listing (tests).
 */
export async function chargeComputerRuntime(
  options: { readonly now?: Date; readonly sessions?: () => AsyncIterable<SessionRecord>; readonly workspaceId?: string } = {},
): Promise<number> {
  if (options.sessions === undefined && (computerMode() !== "vercel" || vercelCredentialsError() !== null)) return 0;
  const now = options.now ?? new Date();
  const since = windowStart(now);
  const rates = computerRates();
  const charges: ComputerCharge[] = [];
  for await (const session of (options.sessions ?? vercelSessions)()) {
    if (session.createdAt < since - LONGEST_SESSION_MS) break;
    const charge = chargeFor(session, rates);
    if (charge !== null && charge.stoppedAt.getTime() >= since && periodOf(charge.stoppedAt) <= periodOf(now)) charges.push(charge);
  }
  if (charges.length === 0) return 0;
  return recordComputerSessions(options.workspaceId ?? workspace(), charges, { now });
}

/** How often a process sweeps outside the tick, and how long it waits for one. */
const SOON_EVERY_MS = 5 * 60_000;
const SOON_WAIT_MS = 5_000;
let lastSoon = 0;

/**
 * A sweep at a moment the budget matters (a run asking to start, the usage
 * page), so the computer's finished sessions are charged by the next job
 * rather than the next tick, which is daily on Hobby. Throttled per process,
 * bounded, and best effort: it never holds up what called it, and the tick
 * still sweeps whatever it missed.
 */
export async function chargeComputerRuntimeSoon(): Promise<void> {
  if (Date.now() - lastSoon < SOON_EVERY_MS) return;
  lastSoon = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    chargeComputerRuntime().catch(() => 0),
    new Promise((resolve) => (timer = setTimeout(resolve, SOON_WAIT_MS))),
  ]).finally(() => clearTimeout(timer));
}
