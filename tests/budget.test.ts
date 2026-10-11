import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The workspace budget (lib/budget.ts): one document per workspace and month,
 * every decision a single compare-and-set on it (docs/decisions/0001-state-store.md,
 * I4). Run against the two backends that work without credentials.
 */
const backends = ["memory", "fs"] as const;
const WS = "default";
const LIMITS = { monthlyUsd: 10, dailyUsd: null };

describe.each(backends)("workspace budget on the %s store", (backend) => {
  let root: string;

  beforeEach(async () => {
    vi.resetModules();
    root = await mkdtemp(join(tmpdir(), "bot-budget-"));
    vi.stubEnv("BOT_STORE", backend);
    vi.stubEnv("BOT_DATA_DIR", root);
    vi.stubEnv("BOT_BUDGET_MONTHLY_USD", "10");
    vi.stubEnv("BOT_BUDGET_DAILY_USD", "");
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  const load = () => import("../agent/lib/budget");

  it("never admits past the limit when many runs ask at once", async () => {
    const { admitRun, readBudget } = await load();
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => admitRun(WS, `lease_${i}`, 1.5, { jobId: `job_${i}` })),
    );
    const admitted = results.filter((result) => result.ok);
    expect(admitted).toHaveLength(6);
    const doc = await readBudget(WS);
    expect(doc.reservedUsd).toBe(9);
    expect(Object.keys(doc.reservations)).toHaveLength(6);
    const refused = results.find((result) => !result.ok);
    expect(refused?.ok === false && refused.reason).toMatch(/BOT_BUDGET_MONTHLY_USD/);
  });

  it("admits a run once however often it asks", async () => {
    const { admitRun, readBudget } = await load();
    const first = await admitRun(WS, "lease_a", 2);
    const again = await admitRun(WS, "lease_a", 2);
    expect(first).toEqual({ ok: true, reservedUsd: 2, alreadyAdmitted: false });
    expect(again).toEqual({ ok: true, reservedUsd: 2, alreadyAdmitted: true });
    expect((await readBudget(WS)).reservedUsd).toBe(2);
  });

  it("settling gives back what a run held but did not spend", async () => {
    const { admitRun, recordSpend, settleRun, readBudget } = await load();
    await admitRun(WS, "lease_a", 6);
    expect((await admitRun(WS, "lease_b", 6)).ok).toBe(false);
    await recordSpend(WS, "lease_a", 0.4, "job");
    expect((await readBudget(WS)).reservedUsd).toBe(5.6);
    expect(await settleRun(WS, "lease_a")).toBe(true);
    expect(await settleRun(WS, "lease_a")).toBe(false);
    const doc = await readBudget(WS);
    expect(doc.reservedUsd).toBe(0);
    expect(doc.spentUsd).toBe(0.4);
    expect(doc.reservations.lease_a).toMatchObject({ state: "settled", spentUsd: 0.4 });
    expect((await admitRun(WS, "lease_b", 6)).ok).toBe(true);
  });

  it("releases a cancelled or superseded run, idempotently, and never reopens a settled one", async () => {
    const { admitRun, releaseRun, settleRun, readBudget } = await load();
    await admitRun(WS, "lease_a", 3);
    await admitRun(WS, "lease_b", 3);
    expect(await releaseRun(WS, "lease_a")).toBe(true);
    expect(await releaseRun(WS, "lease_a")).toBe(false);
    expect(await settleRun(WS, "lease_a")).toBe(false);
    await settleRun(WS, "lease_b");
    expect(await releaseRun(WS, "lease_b")).toBe(false);
    const doc = await readBudget(WS);
    expect(doc.reservations.lease_a?.state).toBe("released");
    expect(doc.reservations.lease_b?.state).toBe("settled");
    expect(doc.reservedUsd).toBe(0);
    // A token never admitted: nothing to release, and no error.
    expect(await releaseRun(WS, "lease_unknown")).toBe(false);
  });

  it("counts an unreported cost as unknown, never as zero spent", async () => {
    const { admitRun, recordSpend, readBudget, budgetStatus } = await load();
    await admitRun(WS, "lease_a", 1);
    expect(await recordSpend(WS, "lease_a", null, "job")).toEqual({ counted: true, halted: false });
    await recordSpend(WS, null, null, "jev");
    const doc = await readBudget(WS);
    expect(doc.unknownCostCount).toBe(2);
    expect(doc.spentUsd).toBe(0);
    expect(doc.reservations.lease_a?.unknownCostCount).toBe(1);
    expect(doc.byCategory.jev).toEqual({ spentUsd: 0, unknownCostCount: 1 });
    const status = await budgetStatus(WS);
    expect(status.unknownCostCount).toBe(2);
    expect(status.unpriced.length).toBeGreaterThan(0);
  });

  it("counts a spend once when it is delivered twice", async () => {
    const { recordSpend, readBudget } = await load();
    await Promise.all([recordSpend(WS, null, 0.5, "hq", { id: "evt_1" }), recordSpend(WS, null, 0.5, "hq", { id: "evt_1" })]);
    await recordSpend(WS, null, 0.5, "hq", { id: "evt_1" });
    expect((await readBudget(WS)).spentUsd).toBe(0.5);
  });

  it("workspace-level spend (HQ, Jev, memory) uses up what runs may reserve", async () => {
    const { admitRun, recordSpend } = await load();
    await recordSpend(WS, null, 9, "hq");
    expect((await admitRun(WS, "lease_a", 1.5)).ok).toBe(false);
    expect((await admitRun(WS, "lease_b", 0.25)).ok).toBe(true);
  });

  it("gives each routine cycle its own reservation", async () => {
    const { admitRun, recordSpend, settleRun, readBudget } = await load();
    for (const cycle of [1, 2, 3]) {
      const token = `lease_cycle${cycle}`;
      expect((await admitRun(WS, token, 3, { jobId: "job_routine" })).ok).toBe(true);
      await recordSpend(WS, token, 3, "job");
      await settleRun(WS, token);
    }
    // 9 spent: a fourth cycle cannot reserve its 3, though each cycle alone fit.
    expect((await admitRun(WS, "lease_cycle4", 3, { jobId: "job_routine" })).ok).toBe(false);
    const doc = await readBudget(WS);
    expect(doc.spentUsd).toBe(9);
    expect(Object.keys(doc.reservations).filter((token) => token.startsWith("lease_cycle"))).toHaveLength(3);
  });

  it("halts a run that spends past its reservation once the workspace has no headroom", async () => {
    const { admitRun, recordSpend, runHalted } = await load();
    await admitRun(WS, "lease_a", 4);
    await admitRun(WS, "lease_b", 4);
    // Within its reservation: never halted.
    expect((await recordSpend(WS, "lease_a", 3.9, "job")).halted).toBe(false);
    // Past it, but the workspace still has room: carries on.
    expect((await recordSpend(WS, "lease_a", 1, "job")).halted).toBe(false);
    // Past it with nothing left: its next step is refused.
    expect((await recordSpend(WS, "lease_a", 1.5, "job")).halted).toBe(true);
    expect(await runHalted(WS, "lease_a")).toBe(true);
    expect(await runHalted(WS, "lease_b")).toBe(false);
  });

  it("keeps a run's spend and settlement on the month that admitted it", async () => {
    const { admitRun, recordSpend, settleRun, readBudget } = await load();
    const lastDay = new Date("2026-10-31T23:59:00Z");
    const nextDay = new Date("2026-11-01T00:05:00Z");
    await admitRun(WS, "lease_a", 2, { now: lastDay });
    await recordSpend(WS, "lease_a", 1, "job", { now: nextDay });
    await settleRun(WS, "lease_a", { now: nextDay });
    const october = await readBudget(WS, "2026-10");
    expect(october.reservations.lease_a).toMatchObject({ state: "settled", spentUsd: 1 });
    expect(october.reservedUsd).toBe(0);
    expect((await readBudget(WS, "2026-11")).spentUsd).toBe(0);
  });

  it("applies the daily limit too", async () => {
    vi.stubEnv("BOT_BUDGET_DAILY_USD", "2");
    const { admitRun, recordSpend } = await load();
    await recordSpend(WS, null, 1.5, "hq");
    const refused = await admitRun(WS, "lease_a", 1);
    expect(refused.ok === false && refused.reason).toMatch(/BOT_BUDGET_DAILY_USD/);
  });

  it("tracks spend without refusing when no limit is set", async () => {
    vi.stubEnv("BOT_BUDGET_MONTHLY_USD", "");
    const { admitRun, recordSpend, budgetStatus } = await load();
    await recordSpend(WS, null, 500, "hq");
    expect((await admitRun(WS, "lease_a", 4)).ok).toBe(true);
    const status = await budgetStatus(WS);
    expect(status).toMatchObject({ limitUsd: null, spentUsd: 500, reservedUsd: 4, remainingUsd: null, heldRuns: 1 });
  });

  it("repairs a reservation whose run crashed before settling", async () => {
    const { admitRun, repairReservations, readBudget } = await load();
    const start = new Date();
    await admitRun(WS, "lease_dead", 5, { jobId: "job_dead", now: start });
    await admitRun(WS, "lease_live", 4, { jobId: "job_live", now: start });
    const later = new Date(start.getTime() + 5 * 60_000);
    const released = await repairReservations(WS, { now: later, isLive: async (jobId) => jobId === "job_live" });
    expect(released).toBe(1);
    const doc = await readBudget(WS);
    expect(doc.reservations.lease_dead?.state).toBe("released");
    expect(doc.reservations.lease_live?.state).toBe("held");
    expect(doc.reservedUsd).toBe(4);
  });

  it("leaves a fresh reservation alone during repair", async () => {
    const { admitRun, repairReservations } = await load();
    const start = new Date();
    await admitRun(WS, "lease_new", 5, { jobId: "job_new", now: start });
    expect(await repairReservations(WS, { now: new Date(start.getTime() + 30_000), isLive: async () => false })).toBe(0);
  });
});

describe("budget admission on a claimed job", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("BOT_STORE", "memory");
    vi.stubEnv("BOT_BUDGET_MONTHLY_USD", "1");
  });

  async function claimed(effort: "quick" | "standard" | "deep") {
    const { assignJob, claimJob } = await import("../agent/lib/jobs");
    const job = await assignJob({ workspaceId: WS, botId: "bot_x", requestedBy: "op", title: "Check the inbox", brief: "Check it.", effort });
    const token = `lease_${Math.random().toString(36).slice(2)}`;
    const claim = await claimJob(WS, job.id, { token, forMs: 20 * 60_000, status: "running", kind: "run", countAttempt: true });
    if (!claim.ok) throw new Error(claim.reason);
    return { job: claim.job, token };
  }

  it("blocks a refused job with the reason, where the board and the feed show it", async () => {
    const { admitClaimedRun } = await import("../agent/lib/budget");
    const { getJob } = await import("../agent/lib/jobs");
    const { recentActivity } = await import("../agent/lib/activity");
    const { job, token } = await claimed("standard");
    const reason = await admitClaimedRun(WS, job, token);
    expect(reason).toMatch(/budget/);
    const after = await getJob(WS, job.id);
    expect(after?.status).toBe("blocked");
    expect(after?.lease).toBeNull();
    const feed = await recentActivity(WS, { jobId: job.id, limit: 10 });
    expect(feed.some((event) => event.kind === "job.blocked" && event.text.includes("BOT_BUDGET_MONTHLY_USD"))).toBe(true);
  });

  it("admits a job whose estimate fits and keeps it running", async () => {
    const { admitClaimedRun, readBudget } = await import("../agent/lib/budget");
    const { getJob } = await import("../agent/lib/jobs");
    const { job, token } = await claimed("quick");
    expect(await admitClaimedRun(WS, job, token)).toBeNull();
    expect((await getJob(WS, job.id))?.status).toBe("running");
    expect((await readBudget(WS)).reservations[token]).toMatchObject({ jobId: job.id, reservedUsd: 0.25, state: "held" });
  });

  it("repairs a held reservation whose job lease went to another run", async () => {
    const { admitClaimedRun, repairReservations, readBudget } = await import("../agent/lib/budget");
    const { patchJob } = await import("../agent/lib/jobs");
    const { job, token } = await claimed("quick");
    await admitClaimedRun(WS, job, token);
    // The run crashed; a later run took the job over with its own token.
    await patchJob(WS, job.id, (current) => ({ ...current, lease: { token: "lease_other", kind: "run", until: new Date(Date.now() + 60_000).toISOString() } }));
    expect(await repairReservations(WS, { now: new Date(Date.now() + 5 * 60_000) })).toBe(1);
    expect((await readBudget(WS)).reservations[token]?.state).toBe("released");
  });

  it("an admission refused only by a dead run's hold repairs it and admits", async () => {
    const { admitRun, readBudget } = await import("../agent/lib/budget");
    const start = new Date(Date.now() - 10 * 60_000);
    await admitRun(WS, "lease_dead", 0.9, { jobId: "job_gone", now: start });
    const admission = await admitRun(WS, "lease_new", 0.5, { jobId: "job_new" });
    expect(admission.ok).toBe(true);
    expect((await readBudget(WS)).reservations.lease_dead?.state).toBe("released");
  });
});
