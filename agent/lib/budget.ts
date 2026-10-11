import { record } from "./activity";
import { blockJob, deferRun, getJob } from "./jobs";
import { DEFAULT_EFFORT, type JobEffort } from "./models";
import { readDoc, store, updateDoc } from "./store";
import type { Job } from "./types";

/**
 * What the workspace may spend, and what it has, per calendar month.
 *
 * The per-session caps (`maxTokenCostUsdPerSession`) bound one session; they
 * reset with every fresh session, every routine cycle and every retry, and
 * know nothing of the calls made outside a session (Jev, memory). This is the
 * aggregate: one document per workspace and UTC month, `budget/<ws>/<YYYY-MM>.json`,
 * holding the limit, everything spent, and a reservation per run.
 *
 * Everything that decides is one compare-and-set on that one document
 * (docs/decisions/0001-state-store.md, I4): a run is admitted only if what was
 * spent, plus what running jobs still hold, plus its own estimate, fits under
 * the limit, and the check and the reservation are the same write. Per-run
 * records are never summed to decide.
 *
 * Lifecycle of a run's reservation, keyed by its run token (the job lease's
 * token, so every routine cycle and every retry is its own reservation and
 * none inherits another's authority):
 *
 * - `admitRun` holds `estimateUsd` for it, or refuses.
 * - `recordSpend` adds each model step's cost to it (and to the month). A cost
 *   the provider did not report is counted as unknown, never as zero.
 * - `settleRun` (it finished: done, failed, blocked, parked for sign-off) or
 *   `releaseRun` (cancelled, superseded) drop what it held but did not spend.
 * - `repairReservations` releases holds whose run died without saying so.
 *
 * Every mutate recognises its own change (the reservation is already there,
 * the spend id is already counted, the reservation is already closed) and
 * treats that as success, because on Blob a write that landed can come back as
 * a conflict and run the mutate again. `updateDoc` giving up after its retries
 * means "not admitted", never "admitted".
 *
 * Limits come from the environment, so a deployment's owner sets them where
 * they set everything else: `BOT_BUDGET_MONTHLY_USD` and `BOT_BUDGET_DAILY_USD`
 * (unset, empty, `0` or `off` = no limit). Spend is tracked either way.
 *
 * Not priced here: the computer's runtime (Vercel Sandbox time and the
 * browser's CPU). Nothing in the app knows its rate, the computer is shared by
 * every run in the workspace, and Vercel bills it on its own line; the status
 * says so (`unpriced`) rather than pretending it is free.
 */

export type ReservationState = "held" | "settled" | "released";

export interface Reservation {
  /** The job the run belongs to, so repair can ask whether the run still holds it. */
  readonly jobId: string | null;
  readonly reservedUsd: number;
  readonly spentUsd: number;
  /** Steps this run made whose cost nobody reported. */
  readonly unknownCostCount: number;
  readonly state: ReservationState;
  /** When it was admitted. */
  readonly at: string;
  readonly closedAt?: string;
  /** The call that closed it, so that call knows its own close when the write comes back as a conflict. */
  readonly closedBy?: string;
  /** Spent past its reservation while the workspace had no headroom: no more model steps. */
  readonly halted?: boolean;
}

/** What one kind of spender spent this period. */
export interface CategorySpend {
  readonly spentUsd: number;
  readonly unknownCostCount: number;
}

export type SpendCategory = "job" | "hq" | "jev" | "memory" | "computer";

export interface BudgetDoc {
  readonly workspaceId: string;
  /** UTC month, `YYYY-MM`. */
  readonly period: string;
  /** The limits in force at the last write, for display; the environment is the source of truth. */
  readonly limitUsd: number | null;
  readonly dailyLimitUsd: number | null;
  /** Everything counted this period: runs, HQ, Jev, memory. */
  readonly spentUsd: number;
  /** What held reservations still hold beyond what their runs spent. Derived from `reservations` on every write. */
  readonly reservedUsd: number;
  /** Model calls whose cost nobody reported; their spend is not in `spentUsd`. */
  readonly unknownCostCount: number;
  readonly byCategory: Readonly<Partial<Record<SpendCategory, CategorySpend>>>;
  /** Spend by UTC day (`YYYY-MM-DD`), for the daily limit. At most a month of entries. */
  readonly days: Readonly<Record<string, number>>;
  /** Held reservations, plus the most recent `CLOSED_KEPT` closed ones. */
  readonly reservations: Readonly<Record<string, Reservation>>;
  /** The last `SPEND_IDS_KEPT` spend ids, so a spend applied twice (a retry, a re-delivered event) counts once. */
  readonly recentSpendIds: readonly string[];
  readonly updatedAt: string;
}

export interface BudgetLimits {
  readonly monthlyUsd: number | null;
  readonly dailyUsd: number | null;
}

/**
 * Closed reservations kept for idempotency and display. Held ones are never
 * pruned. A month of a 10-minute routine is ~4,300 runs, so the map is capped
 * by count, newest kept; a settle or release that finds no entry is a no-op,
 * since a pruned entry holds nothing.
 */
export const CLOSED_KEPT = 200;
export const SPEND_IDS_KEPT = 256;

/**
 * How far a run may spend past its reservation, while the workspace is out of
 * headroom, before its next model step is refused: 10% of what it reserved,
 * and never less than five cents, so rounding never halts a run.
 */
const overrunMargin = (reservedUsd: number) => Math.max(0.05, reservedUsd * 0.1);

/** A held reservation younger than this is never repaired: its lease may still be landing. */
export const REPAIR_GRACE_MS = 2 * 60_000;

/**
 * What a run is assumed to cost before it starts, by effort. Deliberately on
 * the high side of a typical run on the default models (`models.ts`: quick is
 * about a tenth of standard, deep about 2.5 times), and never above the
 * per-session cap, which bounds what one run can spend anyway. What a run
 * does not spend goes back when it settles, so a high estimate costs
 * concurrency, not money.
 */
export const EFFORT_ESTIMATE_USD: Readonly<Record<JobEffort, number>> = {
  quick: 0.25,
  standard: 1.5,
  deep: 4,
};

export function estimateForEffort(effort: JobEffort, env: NodeJS.ProcessEnv = process.env): number {
  const cap = Number(env.BOT_JOB_COST_LIMIT_USD ?? 5);
  const estimate = EFFORT_ESTIMATE_USD[effort];
  return Number.isFinite(cap) && cap > 0 ? Math.min(estimate, cap) : estimate;
}

function limitFrom(value: string | undefined): number | null {
  const trimmed = value?.trim() ?? "";
  if (trimmed === "" || /^(0|off|false|none)$/i.test(trimmed)) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(`[bot] Ignoring budget limit "${trimmed}"; expected a positive number of USD.`);
    return null;
  }
  return parsed;
}

export function budgetLimits(env: NodeJS.ProcessEnv = process.env): BudgetLimits {
  return { monthlyUsd: limitFrom(env.BOT_BUDGET_MONTHLY_USD), dailyUsd: limitFrom(env.BOT_BUDGET_DAILY_USD) };
}

export const periodOf = (at: Date): string => at.toISOString().slice(0, 7);
const dayOf = (at: Date): string => at.toISOString().slice(0, 10);
const previousPeriod = (at: Date): string => periodOf(new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() - 1, 15)));
const money = (usd: number): number => Math.round(usd * 1e6) / 1e6;
const key = (workspaceId: string, period: string) => `budget/${workspaceId}/${period}.json`;

export function emptyBudget(workspaceId: string, period: string): BudgetDoc {
  return {
    workspaceId,
    period,
    limitUsd: null,
    dailyLimitUsd: null,
    spentUsd: 0,
    reservedUsd: 0,
    unknownCostCount: 0,
    byCategory: {},
    days: {},
    reservations: {},
    recentSpendIds: [],
    updatedAt: "",
  };
}

/** What a held reservation still holds beyond what its run spent. */
const outstanding = (reservation: Reservation): number =>
  reservation.state === "held" ? Math.max(0, reservation.reservedUsd - reservation.spentUsd) : 0;

/** Recomputes the derived total and prunes the map; every write goes through it. */
function seal(doc: BudgetDoc, limits: BudgetLimits, at: Date): BudgetDoc {
  const entries = Object.entries(doc.reservations);
  const held = entries.filter(([, reservation]) => reservation.state === "held");
  const closed = entries
    .filter(([, reservation]) => reservation.state !== "held")
    .sort(([, left], [, right]) => (right.closedAt ?? right.at).localeCompare(left.closedAt ?? left.at))
    .slice(0, CLOSED_KEPT);
  return {
    ...doc,
    limitUsd: limits.monthlyUsd,
    dailyLimitUsd: limits.dailyUsd,
    reservations: Object.fromEntries([...held, ...closed]),
    reservedUsd: money(held.reduce((sum, [, reservation]) => sum + outstanding(reservation), 0)),
    recentSpendIds: doc.recentSpendIds.slice(-SPEND_IDS_KEPT),
    updatedAt: at.toISOString(),
  };
}

const usd = (value: number) => `$${value.toFixed(2)}`;

// ---------------------------------------------------------------------------
// Pure transitions
// ---------------------------------------------------------------------------

/**
 * Why a run was not admitted:
 *
 * - `limit`: it does not fit under the monthly or daily limit. A decision; the
 *   job waits for a person.
 * - `closed`: its reservation was already closed (the run was cancelled or
 *   superseded meanwhile). A decision too.
 * - `unavailable`: the budget could not be checked (a store failure, or
 *   contention past `updateDoc`'s retries). Not a decision: try again shortly.
 */
export type Refusal = "limit" | "closed" | "unavailable";

export type Admission =
  | { readonly ok: true; readonly reservedUsd: number; readonly alreadyAdmitted: boolean }
  | { readonly ok: false; readonly refusal: Refusal; readonly reason: string };

/**
 * Admits a run, or says why not. `next` is null when nothing should be written
 * (already admitted, which is success, or refused).
 */
export function applyAdmit(
  current: BudgetDoc,
  input: { readonly runToken: string; readonly jobId: string | null; readonly estimateUsd: number; readonly limits: BudgetLimits; readonly at: Date },
): { next: BudgetDoc | null; admission: Admission } {
  const existing = current.reservations[input.runToken];
  if (existing !== undefined) {
    // Ours already: a replayed step, or a write that landed but came back as a conflict.
    return existing.state === "held"
      ? { next: null, admission: { ok: true, reservedUsd: existing.reservedUsd, alreadyAdmitted: true } }
      : { next: null, admission: { ok: false, refusal: "closed", reason: "This run's budget reservation was already closed." } };
  }
  const estimate = money(Math.max(0, input.estimateUsd));
  const committed = current.spentUsd + current.reservedUsd;
  const { monthlyUsd, dailyUsd } = input.limits;
  let reason: string | null = null;
  if (monthlyUsd !== null && committed + estimate > monthlyUsd) {
    reason = `The workspace's budget for ${current.period} is ${usd(monthlyUsd)}: ${usd(current.spentUsd)} is spent and ${usd(current.reservedUsd)} is held by running jobs, and this run needs about ${usd(estimate)}. Raise BOT_BUDGET_MONTHLY_USD or wait for next month, then run it again.`;
  } else if (dailyUsd !== null) {
    const today = current.days[dayOf(input.at)] ?? 0;
    if (today + current.reservedUsd + estimate > dailyUsd) {
      reason = `The workspace's daily budget is ${usd(dailyUsd)}: ${usd(today)} is spent today (UTC) and ${usd(current.reservedUsd)} is held by running jobs, and this run needs about ${usd(estimate)}. Raise BOT_BUDGET_DAILY_USD or wait until tomorrow (UTC), then run it again.`;
    }
  }
  if (reason !== null) {
    // A refusal is not written: it changes nothing, and writing it would contend with admissions that fit.
    return { next: null, admission: { ok: false, refusal: "limit", reason } };
  }
  const reservation: Reservation = {
    jobId: input.jobId,
    reservedUsd: estimate,
    spentUsd: 0,
    unknownCostCount: 0,
    state: "held",
    at: input.at.toISOString(),
  };
  return {
    next: seal({ ...current, reservations: { ...current.reservations, [input.runToken]: reservation } }, input.limits, input.at),
    admission: { ok: true, reservedUsd: estimate, alreadyAdmitted: false },
  };
}

export interface SpendOutcome {
  /** The spend is on the books (now, or by an earlier delivery of the same id). */
  readonly counted: boolean;
  /** The run this spend belongs to may make no more model steps. */
  readonly halted: boolean;
}

/** Adds one model call's cost; `usd: null` is a call whose cost nobody reported. */
export function applySpend(
  current: BudgetDoc,
  input: {
    readonly runToken: string | null;
    readonly usd: number | null;
    readonly category: SpendCategory;
    readonly id: string;
    readonly limits: BudgetLimits;
    readonly at: Date;
  },
): { next: BudgetDoc | null; outcome: SpendOutcome } {
  const reservation = input.runToken === null ? undefined : current.reservations[input.runToken];
  if (current.recentSpendIds.includes(input.id)) {
    return { next: null, outcome: { counted: true, halted: reservation?.halted === true } };
  }
  const known = input.usd !== null && Number.isFinite(input.usd);
  const amount = known ? money(Math.max(0, input.usd as number)) : 0;
  const unknown = known ? 0 : 1;
  const day = dayOf(input.at);
  const category = current.byCategory[input.category] ?? { spentUsd: 0, unknownCostCount: 0 };

  const base: BudgetDoc = {
    ...current,
    spentUsd: money(current.spentUsd + amount),
    unknownCostCount: current.unknownCostCount + unknown,
    byCategory: {
      ...current.byCategory,
      [input.category]: { spentUsd: money(category.spentUsd + amount), unknownCostCount: category.unknownCostCount + unknown },
    },
    days: { ...current.days, [day]: money((current.days[day] ?? 0) + amount) },
    recentSpendIds: [...current.recentSpendIds, input.id],
  };
  if (reservation === undefined || input.runToken === null) {
    // Workspace-level spend (HQ, an aux call outside any run), or a run whose entry was pruned.
    return { next: seal(base, input.limits, input.at), outcome: { counted: true, halted: false } };
  }

  let charged: Reservation = {
    ...reservation,
    spentUsd: money(reservation.spentUsd + amount),
    unknownCostCount: reservation.unknownCostCount + unknown,
  };
  const withRun = seal({ ...base, reservations: { ...base.reservations, [input.runToken]: charged } }, input.limits, input.at);
  if (charged.state === "held" && charged.halted !== true) {
    const over = charged.spentUsd - charged.reservedUsd;
    const committed = withRun.spentUsd + withRun.reservedUsd;
    const today = withRun.days[day] ?? 0;
    const noHeadroom =
      (input.limits.monthlyUsd !== null && committed >= input.limits.monthlyUsd) ||
      (input.limits.dailyUsd !== null && today + withRun.reservedUsd >= input.limits.dailyUsd);
    if (over > overrunMargin(charged.reservedUsd) && noHeadroom) charged = { ...charged, halted: true };
  }
  return {
    next: { ...withRun, reservations: { ...withRun.reservations, [input.runToken]: charged } },
    outcome: { counted: true, halted: charged.halted === true },
  };
}

/** Closes a reservation. Closing one already closed, or one not on this doc, writes nothing and is success. */
export function applyClose(
  current: BudgetDoc,
  input: {
    readonly runToken: string;
    readonly state: Exclude<ReservationState, "held">;
    readonly limits: BudgetLimits;
    readonly at: Date;
    readonly by?: string;
  },
): BudgetDoc | null {
  const reservation = current.reservations[input.runToken];
  if (reservation === undefined || reservation.state !== "held") return null;
  return seal(
    {
      ...current,
      reservations: {
        ...current.reservations,
        [input.runToken]: {
          ...reservation,
          state: input.state,
          closedAt: input.at.toISOString(),
          ...(input.by === undefined ? {} : { closedBy: input.by }),
        },
      },
    },
    input.limits,
    input.at,
  );
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export async function readBudget(workspaceId: string, period: string = periodOf(new Date())): Promise<BudgetDoc> {
  return (await readDoc<BudgetDoc>(key(workspaceId, period)))?.value ?? emptyBudget(workspaceId, period);
}

/**
 * Applies `mutate` to the document that holds a run's reservation: this
 * month's, or, for a run admitted before midnight UTC on the last day of the
 * month, last month's. A run's spend stays with the month that admitted it.
 *
 * This month's is tried in the compare-and-set that writes it, and last
 * month's is read only when the reservation is not there, so the common path
 * reads the budget once. `period` is null when neither holds it; `written`
 * says whether `mutate` changed anything.
 */
async function updateHolding(
  workspaceId: string,
  runToken: string,
  at: Date,
  mutate: (current: BudgetDoc) => BudgetDoc | null,
): Promise<{ period: string | null; written: boolean }> {
  for (const period of [periodOf(at), previousPeriod(at)]) {
    const seen = { found: false };
    const written = await updateDoc<BudgetDoc>(key(workspaceId, period), (current) => {
      seen.found = current !== null && current.reservations[runToken] !== undefined;
      return current !== null && seen.found ? mutate(current) : null;
    });
    if (seen.found) return { period, written: written !== null };
  }
  return { period: null, written: false };
}

/**
 * Holds `estimateUsd` of the workspace's budget for one run, or refuses.
 *
 * Idempotent per `runToken`: admitting a run already admitted succeeds without
 * holding twice. A refusal when held reservations look stale repairs them
 * (releases holds whose run no longer holds its job) and tries once more, so a
 * crashed run cannot keep the workspace locked until the next watchdog pass.
 */
export async function admitRun(
  workspaceId: string,
  runToken: string,
  estimateUsd: number,
  options: { readonly jobId?: string | null; readonly now?: Date; readonly limits?: BudgetLimits } = {},
): Promise<Admission> {
  const attempt = async (): Promise<Admission> => {
    const at = options.now ?? new Date();
    const limits = options.limits ?? budgetLimits();
    const outcome: { admission: Admission } = { admission: { ok: false, refusal: "unavailable", reason: "The budget could not be read." } };
    try {
      await updateDoc<BudgetDoc>(key(workspaceId, periodOf(at)), (current) => {
        const result = applyAdmit(current ?? emptyBudget(workspaceId, periodOf(at)), {
          runToken,
          jobId: options.jobId ?? null,
          estimateUsd,
          limits,
          at,
        });
        outcome.admission = result.admission;
        return result.next;
      });
    } catch (error) {
      // Contention past updateDoc's retries, or a store failure: not admitted.
      return {
        ok: false,
        refusal: "unavailable",
        reason: `The workspace budget could not be checked (${error instanceof Error ? error.message : String(error)}); try again shortly.`,
      };
    }
    return outcome.admission;
  };

  const first = await attempt();
  // Only a refusal on the numbers can be undone by repair; a store that could not be read cannot.
  if (first.ok || first.refusal !== "limit") return first;
  const repaired = await repairReservations(workspaceId, { now: options.now }).catch(() => 0);
  return repaired > 0 ? attempt() : first;
}

/**
 * Counts one model call's cost against the workspace, and against the run's
 * reservation when `runToken` names one. `usd: null` means nobody reported a
 * cost: it is counted as unknown (`unknownCostCount`), never as zero spent.
 *
 * `id` makes it idempotent: give the event's id when there is one, so a
 * re-delivered hook event is counted once. Never throws; a spend that could
 * not be written comes back `counted: false` and is logged.
 */
export async function recordSpend(
  workspaceId: string,
  runToken: string | null,
  usd: number | null,
  category: SpendCategory,
  options: { readonly id?: string; readonly now?: Date; readonly limits?: BudgetLimits } = {},
): Promise<SpendOutcome> {
  const at = options.now ?? new Date();
  const limits = options.limits ?? budgetLimits();
  const id = options.id ?? `spend_${crypto.randomUUID()}`;
  const outcome: { value: SpendOutcome } = { value: { counted: false, halted: false } };
  const apply = (current: BudgetDoc | null, period: string): BudgetDoc | null => {
    const result = applySpend(current ?? emptyBudget(workspaceId, period), { runToken, usd, category, id, limits, at });
    outcome.value = result.outcome;
    return result.next;
  };
  try {
    const held = runToken === null ? { period: null } : await updateHolding(workspaceId, runToken, at, (current) => apply(current, current.period));
    if (held.period === null) {
      // Workspace-level spend, or a run whose reservation no month holds (pruned): this month's.
      const period = periodOf(at);
      await updateDoc<BudgetDoc>(key(workspaceId, period), (current) => apply(current, period));
    }
  } catch (error) {
    console.warn(`[bot] Could not record spend on the workspace budget: ${error instanceof Error ? error.message : String(error)}`);
    return { counted: false, halted: false };
  }
  return outcome.value;
}

async function close(workspaceId: string, runToken: string, state: "settled" | "released", now?: Date): Promise<boolean> {
  const at = now ?? new Date();
  const limits = budgetLimits();
  const by = `close_${crypto.randomUUID()}`;
  const seen = { mine: false };
  const { written } = await updateHolding(workspaceId, runToken, at, (current) => {
    // Closed by this call already: its write landed but came back as a conflict (Blob).
    seen.mine = current.reservations[runToken]?.closedBy === by;
    return seen.mine ? null : applyClose(current, { runToken, state, limits, at, by });
  });
  return written || seen.mine;
}

/**
 * The run finished (closed, failed, blocked, parked for sign-off, sent back):
 * whatever it held but did not spend goes back. Spend recorded after this
 * (a memory extraction from its feedback, say) still counts. Idempotent, and
 * a no-op on a reservation already released. True when this call closed it.
 */
export function settleRun(workspaceId: string, runToken: string, options: { readonly now?: Date } = {}): Promise<boolean> {
  return close(workspaceId, runToken, "settled", options.now);
}

/** The run was cancelled or superseded: as `settleRun`, recorded as released. */
export function releaseRun(workspaceId: string, runToken: string, options: { readonly now?: Date } = {}): Promise<boolean> {
  return close(workspaceId, runToken, "released", options.now);
}

/** Whether a run went past its reservation with the workspace out of headroom. */
export async function runHalted(workspaceId: string, runToken: string, now: Date = new Date()): Promise<boolean> {
  for (const period of [periodOf(now), previousPeriod(now)]) {
    const reservation = (await readBudget(workspaceId, period)).reservations[runToken];
    if (reservation !== undefined) return reservation.halted === true;
  }
  return false;
}

/**
 * What became of a run that has just claimed its job:
 *
 * - admitted: it holds its estimate and may start.
 * - refused (`retryAt: null`): the budget said no, and the job is blocked with
 *   the reason, waiting on a person.
 * - deferred (`retryAt` set): the budget could not be checked, so the claim
 *   went back and the job waits to be tried again at `retryAt`.
 */
export type ClaimedAdmission =
  | { readonly admitted: true }
  | { readonly admitted: false; readonly reason: string; readonly retryAt: string | null };

/** How long a run waits before checking a budget it could not read again: 30s, doubling, at most 10 minutes. */
export const deferralDelayMs = (deferrals: number): number => Math.min(10 * 60_000, 30_000 * 2 ** Math.max(0, deferrals));

/**
 * Admission for a run that has just claimed its job (`run_job`'s claim step),
 * under the run's lease token.
 *
 * Refused on the numbers: the job is blocked, fenced on that token, with the
 * refusal as its reason, so it shows on the board and the feed as waiting on a
 * person and the watchdog does not re-dispatch it.
 *
 * Not checked at all (the store failed or stayed contended): that is no
 * reason to stop a job, and a blocked routine would never run again. The
 * claim is handed back instead (`deferRun`): the job waits again, due after a
 * short backoff, a routine keeps its schedule, and the feed says so once, on
 * the first deferral. `waitToken` lets the caller hold the job while it
 * sleeps and retry; `deferrals` is how many times it already has.
 */
export async function admitClaimedRun(
  workspaceId: string,
  job: Pick<Job, "id" | "effort" | "title" | "botId">,
  runToken: string,
  options: { readonly waitToken?: string; readonly deferrals?: number; readonly now?: Date } = {},
): Promise<ClaimedAdmission> {
  const admission = await admitRun(workspaceId, runToken, estimateForEffort(job.effort ?? DEFAULT_EFFORT), {
    jobId: job.id,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  if (admission.ok) return { admitted: true };
  if (admission.refusal !== "unavailable") {
    await blockJob(workspaceId, job.id, admission.reason, { token: runToken });
    return { admitted: false, reason: admission.reason, retryAt: null };
  }

  const deferrals = options.deferrals ?? 0;
  const retryAt = new Date((options.now ?? new Date()).getTime() + deferralDelayMs(deferrals)).toISOString();
  // A write that landed but came back as a failure may have reserved after all.
  await releaseRun(workspaceId, runToken, options.now === undefined ? {} : { now: options.now }).catch(() => false);
  const deferred = await deferRun(workspaceId, job.id, runToken, {
    runAt: retryAt,
    ...(options.waitToken === undefined ? {} : { waitToken: options.waitToken }),
  });
  // Cancelled or taken over meanwhile: nothing to hand back, and no retry.
  if (deferred === null) return { admitted: false, reason: admission.reason, retryAt: null };
  if (deferrals === 0) {
    await record({
      workspaceId,
      kind: "job.progress",
      botId: job.botId,
      jobId: job.id,
      text: `"${job.title}" did not start: the workspace budget could not be checked. It will try again at ${retryAt}.`,
      data: { budget: "unavailable", retryAt },
    }).catch(() => undefined);
  }
  return { admitted: false, reason: admission.reason, retryAt };
}

/** What `run_job` blocks a halted run with. */
export const BUDGET_HALT_REASON =
  "Stopped by the workspace budget: this run spent past what it reserved, and the workspace has no budget left this period. Raise BOT_BUDGET_MONTHLY_USD (or BOT_BUDGET_DAILY_USD), or wait for the next period, then run it again.";

/** Whether the run that reserved under `runToken` still holds job `jobId`. */
export type RunLiveness = (jobId: string, runToken: string, now: Date) => Promise<boolean>;

/**
 * Releases held reservations whose run is gone: its job is missing, closed,
 * or leased to another run, or its lease lapsed. That is a run that crashed or
 * was superseded before it could settle. Its spend stays counted; only what it
 * still held goes back. Reservations younger than `REPAIR_GRACE_MS` are left
 * alone. Returns how many were released.
 *
 * Called from the watchdog tick for every workspace with a budget, and from
 * `admitRun` when it would otherwise refuse.
 */
export async function repairReservations(
  workspaceId: string,
  options: { readonly now?: Date; readonly isLive?: RunLiveness } = {},
): Promise<number> {
  const now = options.now ?? new Date();
  const isLive: RunLiveness =
    options.isLive ??
    (async (jobId, runToken, at) => {
      const job = await getJob(workspaceId, jobId);
      return job !== null && job.lease !== null && job.lease.token === runToken && Date.parse(job.lease.until) > at.getTime();
    });
  let released = 0;
  for (const period of [previousPeriod(now), periodOf(now)]) {
    const doc = await readBudget(workspaceId, period);
    for (const [runToken, reservation] of Object.entries(doc.reservations)) {
      if (reservation.state !== "held") continue;
      if (now.getTime() - Date.parse(reservation.at) < REPAIR_GRACE_MS) continue;
      const live = reservation.jobId === null ? false : await isLive(reservation.jobId, runToken, now);
      if (live) continue;
      if (await releaseRun(workspaceId, runToken, { now })) released += 1;
    }
  }
  return released;
}

/**
 * `repairReservations` for every workspace that has a budget document, for the
 * watchdog tick. The listing is only used to find workspaces, never to decide
 * anything, so a stale or partial one costs at most a pass. Returns how many
 * reservations were released.
 */
export async function repairAllReservations(now: Date = new Date()): Promise<number> {
  const keys = await store().list("budget/");
  const workspaces = new Set(keys.map((path) => path.slice("budget/".length).split("/")[0] ?? "").filter((id) => id !== ""));
  let released = 0;
  for (const workspaceId of workspaces) released += await repairReservations(workspaceId, { now }).catch(() => 0);
  return released;
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export interface BudgetStatus {
  readonly period: string;
  readonly limitUsd: number | null;
  readonly dailyLimitUsd: number | null;
  readonly spentUsd: number;
  readonly todaySpentUsd: number;
  readonly reservedUsd: number;
  /** What a new run could still reserve this month; null without a monthly limit. */
  readonly remainingUsd: number | null;
  /** Model calls whose cost nobody reported, so `spentUsd` undercounts by them. */
  readonly unknownCostCount: number;
  readonly heldRuns: number;
  /** Runs stopped this period for spending past their reservation with no headroom left. */
  readonly haltedRuns: number;
  readonly byCategory: BudgetDoc["byCategory"];
  /** Costs nothing here prices, so none of the figures include them. */
  readonly unpriced: readonly string[];
}

export const UNPRICED = ["computer runtime (Vercel Sandbox time is billed by Vercel, not counted here)"] as const;

export function statusOf(doc: BudgetDoc, limits: BudgetLimits, now: Date): BudgetStatus {
  const reservations = Object.values(doc.reservations);
  return {
    period: doc.period,
    limitUsd: limits.monthlyUsd,
    dailyLimitUsd: limits.dailyUsd,
    spentUsd: doc.spentUsd,
    todaySpentUsd: doc.days[dayOf(now)] ?? 0,
    reservedUsd: doc.reservedUsd,
    remainingUsd: limits.monthlyUsd === null ? null : money(Math.max(0, limits.monthlyUsd - doc.spentUsd - doc.reservedUsd)),
    unknownCostCount: doc.unknownCostCount,
    heldRuns: reservations.filter((reservation) => reservation.state === "held").length,
    haltedRuns: reservations.filter((reservation) => reservation.halted === true).length,
    byCategory: doc.byCategory,
    unpriced: UNPRICED,
  };
}

export async function budgetStatus(workspaceId: string, now: Date = new Date()): Promise<BudgetStatus> {
  return statusOf(await readBudget(workspaceId, periodOf(now)), budgetLimits(), now);
}
