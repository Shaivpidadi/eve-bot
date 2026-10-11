import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeBlobService, useFakeBlobEnv } from "./blob-fake";

/**
 * The M1 invariants (docs/decisions/0001-state-store.md, I1–I5) on the Vercel
 * Blob backend, through the real SDK against the fake service, and the code
 * that relies on them under the fault Blob adds: a write that lands but whose
 * answer is lost, so the SDK retries it into our own write and reports a
 * conflict.
 *
 * "Runtimes" are separate module instances (`vi.resetModules` between
 * imports): each has its own in-process key lock, so their writes meet only at
 * the service's compare-and-set, as two function instances on Vercel would.
 */

const blob = new FakeBlobService();
beforeAll(() => blob.start());
afterAll(() => blob.stop());

beforeEach(() => {
  blob.reset();
  vi.resetModules();
  useFakeBlobEnv("t");
});

type StoreModule = typeof import("../agent/lib/store/index");

async function runtimes(count: number): Promise<StoreModule[]> {
  const loaded: StoreModule[] = [];
  for (let i = 0; i < count; i += 1) {
    vi.resetModules();
    loaded.push(await import("../agent/lib/store/index"));
  }
  return loaded;
}

const WS = "wsb";
const RETRY_FAULT_MS = 20_000;

describe("single-document invariants across runtimes on Blob", () => {
  it("loses no increments and adds none: the counter equals the updates that succeeded", async () => {
    const stores = await runtimes(4);
    await stores[0]!.writeDoc("counter", { n: 0 });
    const results = await Promise.allSettled(
      Array.from({ length: 16 }, (_, i) =>
        stores[i % 4]!.updateDoc<{ n: number }>("counter", (current) => ({ n: (current?.n ?? 0) + 1 })),
      ),
    );
    const succeeded = results.filter((result) => result.status === "fulfilled").length;
    expect(succeeded).toBeGreaterThan(0);
    expect((await stores[0]!.readDoc<{ n: number }>("counter"))?.value.n).toBe(succeeded);
    expect(blob.requests("put", "t/counter").some((entry) => entry.status === 412)).toBe(true);
  });

  it("lets exactly one of many simultaneous claims win", async () => {
    const stores = await runtimes(4);
    await stores[0]!.writeDoc("claim", { owner: null as string | null, fence: 0 });
    const results = await Promise.all(
      Array.from({ length: 16 }, (_, i) =>
        stores[i % 4]!.updateDoc<{ owner: string | null; fence: number }>("claim", (current) =>
          current === null || current.owner !== null ? null : { owner: `run-${i}`, fence: current.fence + 1 },
        ),
      ),
    );
    const winners = results.filter((result) => result !== null);
    expect(winners).toHaveLength(1);
    expect((await stores[1]!.readDoc("claim"))?.value).toEqual({ owner: winners[0]?.owner, fence: 1 });
  });

  it("never reserves past a workspace budget limit", async () => {
    const stores = await runtimes(4);
    interface Budget {
      limit: number;
      reserved: number;
      reservations: Record<string, number>;
    }
    await stores[0]!.writeDoc<Budget>("budget", { limit: 100, reserved: 0, reservations: {} });
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) =>
        stores[i % 4]!.updateDoc<Budget>("budget", (current) => {
          if (current === null || current.reserved + 15 > current.limit) return null;
          return { ...current, reserved: current.reserved + 15, reservations: { ...current.reservations, [`run-${i}`]: 15 } };
        }),
      ),
    );
    const budget = (await stores[0]!.readDoc<Budget>("budget"))!.value;
    const admitted = results.filter((result) => result.status === "fulfilled" && result.value !== null).length;
    expect(budget.reserved).toBeLessThanOrEqual(100);
    expect(Object.keys(budget.reservations)).toHaveLength(admitted);
    expect(budget.reserved).toBe(15 * admitted);
  });

  it("moves an approval out of `proposed` exactly once", async () => {
    const stores = await runtimes(5);
    type Action = { state: "proposed" | "approved" | "rejected"; by: string | null };
    await stores[0]!.writeDoc<Action>("action", { state: "proposed", by: null });
    const results = await Promise.all(
      (["approved", "rejected", "approved", "rejected", "approved"] as const).map((state, i) =>
        stores[i]!.updateDoc<Action>("action", (current) => (current?.state === "proposed" ? { state, by: `reviewer-${i}` } : null)),
      ),
    );
    const applied = results.filter((result) => result !== null);
    expect(applied).toHaveLength(1);
    expect((await stores[0]!.readDoc<Action>("action"))?.value).toEqual(applied[0]);
  });

  it("creates a key exactly once under simultaneous create-if-absent writes", async () => {
    const stores = await runtimes(4);
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, (_, i) => stores[i % 4]!.writeDoc("inbox/e1", { delivery: i }, null)),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    // Each runtime has its own KvConflictError class, so each judges its own rejection.
    expect(results.filter((result, i) => result.status === "rejected" && stores[i % 4]!.isConflict(result.reason))).toHaveLength(11);
  });

  it("creates exactly once through updateDoc too", async () => {
    const stores = await runtimes(4);
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        stores[i % 4]!.updateDoc<{ receipt: string }>("ledger", (current) => (current === null ? { receipt: `r-${i}` } : null)),
      ),
    );
    const created = results.filter((result) => result !== null);
    expect(created).toHaveLength(1);
    expect((await stores[0]!.readDoc("ledger"))?.value).toEqual(created[0]);
  });
});

describe("the workspace budget on Blob", () => {
  const limits = { monthlyUsd: 100, dailyUsd: null };

  it("admits concurrent runs from several runtimes without overshooting the limit", async () => {
    const budgets: (typeof import("../agent/lib/budget"))[] = [];
    for (let i = 0; i < 4; i += 1) {
      vi.resetModules();
      budgets.push(await import("../agent/lib/budget"));
    }
    const now = new Date();
    const admissions = await Promise.all(
      Array.from({ length: 20 }, (_, i) => budgets[i % 4]!.admitRun(WS, `run-${i}`, 15, { jobId: `job-${i}`, now, limits })),
    );
    const doc = await budgets[0]!.readBudget(WS, budgets[0]!.periodOf(now));
    const admitted = admissions.filter((admission) => admission.ok).length;
    expect(doc.reservedUsd).toBeLessThanOrEqual(100);
    expect(doc.reservedUsd).toBe(15 * admitted);
    expect(Object.keys(doc.reservations)).toHaveLength(admitted);
    expect(admissions.every((admission) => admission.ok || admission.refusal !== "closed")).toBe(true);
  });

  it(
    "admits once, counts a spend once and closes once when each write's answer is lost",
    async () => {
      const budget = await import("../agent/lib/budget");
      const now = new Date();
      const path = `t/budget/${WS}/${budget.periodOf(now)}.json`;

      blob.inject({ kind: "lose-response", op: "put", pathname: path });
      const admission = await budget.admitRun(WS, "run-1", 2, { jobId: "job-1", now, limits });
      expect(admission).toEqual({ ok: true, reservedUsd: 2, alreadyAdmitted: true });

      blob.inject({ kind: "lose-response", op: "put", pathname: path });
      const spend = await budget.recordSpend(WS, "run-1", 0.5, "job", { id: "evt-1", now, limits });
      expect(spend).toEqual({ counted: true, halted: false });

      blob.inject({ kind: "lose-response", op: "put", pathname: path });
      expect(await budget.settleRun(WS, "run-1", { now })).toBe(true);
      expect(await budget.settleRun(WS, "run-1", { now })).toBe(false);

      const doc = await budget.readBudget(WS, budget.periodOf(now));
      expect(doc.spentUsd).toBe(0.5);
      expect(doc.recentSpendIds).toEqual(["evt-1"]);
      expect(doc.reservedUsd).toBe(0);
      expect(doc.reservations["run-1"]).toMatchObject({ state: "settled", spentUsd: 0.5, reservedUsd: 2 });
      // Each lost answer was retried into its own write: the create as "already exists", the updates as 412.
      expect(blob.requests("put", path).map((entry) => entry.status)).toEqual(["dropped", 400, "dropped", 412, "dropped", 412]);
    },
    RETRY_FAULT_MS,
  );

  it(
    "repair frees a dead run's hold even when the release's answer is lost, so the refused run is admitted",
    async () => {
      const budget = await import("../agent/lib/budget");
      const then = new Date("2026-10-11T10:00:00Z");
      const later = new Date(then.getTime() + budget.REPAIR_GRACE_MS + 60_000);
      const path = `t/budget/${WS}/${budget.periodOf(then)}.json`;
      vi.stubEnv("BOT_BUDGET_MONTHLY_USD", "10");
      expect((await budget.admitRun(WS, "dead-run", 8, { jobId: "job-gone", now: then })).ok).toBe(true);
      blob.inject({ kind: "lose-response", op: "put", pathname: path });
      // job-gone does not exist, so the hold is a dead run's; repair releases it and admission retries.
      const admission = await budget.admitRun(WS, "new-run", 8, { jobId: "job-new", now: later });
      expect(admission).toMatchObject({ ok: true, alreadyAdmitted: false });
    },
    RETRY_FAULT_MS,
  );
});

describe("jobs on Blob when a write's answer is lost", () => {
  const setup = async () => {
    const jobs = await import("../agent/lib/jobs");
    const bots = await import("../agent/lib/bots");
    const bot = await bots.hireBot({ workspaceId: WS, hiredBy: "test", name: "Ada", role: "analyst", persona: "careful" });
    const job = await jobs.assignJob({ workspaceId: WS, botId: bot.id, requestedBy: "owner", title: "Report", brief: "Write it." });
    return { jobs, bots, bot, job, path: `t/jobs/${WS}/${job.id}.json` };
  };

  it(
    "assigns a job once, and says so, when the create's answer is lost",
    async () => {
      const jobs = await import("../agent/lib/jobs");
      blob.inject({ kind: "lose-response", op: "put", prefix: `t/jobs/${WS}/` });
      const created = jobs.assignJob({ workspaceId: WS, botId: "bot_x", requestedBy: "owner", title: "Once", brief: "b" });
      await expect(created).resolves.toMatchObject({ title: "Once" });
      const listed = await jobs.listJobs(WS);
      expect(listed).toHaveLength(1);
    },
    RETRY_FAULT_MS,
  );

  it(
    "claims a job it won, even when the claim's answer is lost",
    async () => {
      const { jobs, job, path } = await setup();
      blob.inject({ kind: "lose-response", op: "put", pathname: path });
      const claim = await jobs.claimJob(WS, job.id, { token: "tok-1", forMs: 60_000, status: "running", kind: "run", countAttempt: true });
      expect(claim).toMatchObject({ ok: true, job: { status: "running", attempts: 1, lease: { token: "tok-1", kind: "run" } } });
      expect((await jobs.getJob(WS, job.id))?.attempts).toBe(1);
      // Another run still loses: the recognition is by token, not by "someone holds it".
      const other = await jobs.claimJob(WS, job.id, { token: "tok-2", forMs: 60_000, status: "running", kind: "run" });
      expect(other.ok).toBe(false);
    },
    RETRY_FAULT_MS,
  );

  it(
    "binds, renews, attaches and completes once each under lost answers",
    async () => {
      const { jobs, bots, bot, job, path } = await setup();
      await jobs.claimJob(WS, job.id, { token: "tok-1", forMs: 60_000, status: "running", kind: "run" });

      blob.inject({ kind: "lose-response", op: "put", pathname: path });
      expect(await jobs.bindRun(WS, job.id, "tok-1", "sess-1")).toMatchObject({ ok: true });

      blob.inject({ kind: "lose-response", op: "put", pathname: path });
      expect(await jobs.renewLease(WS, job.id, "tok-1", 120_000)).toBe(true);

      blob.inject({ kind: "lose-response", op: "put", pathname: path });
      const artifact = { id: "art-1", name: "r.md", path: "artifacts/r.md", mime: "text/markdown", bytes: 3, at: new Date().toISOString() };
      expect(await jobs.attachArtifact(WS, job.id, artifact as never, "sess-1")).toMatchObject({ ok: true });
      expect((await jobs.getJob(WS, job.id))?.artifacts).toHaveLength(1);

      blob.inject({ kind: "lose-response", op: "put", pathname: path });
      const done = await jobs.completeJob(WS, job.id, { summary: "ok" } as never, { token: "tok-1" });
      expect(done?.status).toBe("done");
      expect((await bots.getBot(WS, bot.id))?.stats.jobsCompleted).toBe(1);
    },
    4 * RETRY_FAULT_MS,
  );

  it(
    "hands a deferred claim back and says so when the deferral's answer is lost",
    async () => {
      const { jobs, job, path } = await setup();
      await jobs.claimJob(WS, job.id, { token: "tok-1", forMs: 60_000, status: "running", kind: "run", countAttempt: true });
      const runAt = new Date(Date.now() + 60_000).toISOString();
      blob.inject({ kind: "lose-response", op: "put", pathname: path });
      const deferred = await jobs.deferRun(WS, job.id, "tok-1", { runAt, waitToken: "wait-1" });
      expect(deferred).toMatchObject({ status: "queued", runAt, attempts: 0, lease: { token: "wait-1", kind: "wait" } });
    },
    RETRY_FAULT_MS,
  );

  it(
    "cancels once, and knows the cancel was its own, when the answer is lost",
    async () => {
      const { jobs, job, path } = await setup();
      await jobs.claimJob(WS, job.id, { token: "tok-1", forMs: 60_000, status: "running", kind: "run" });
      blob.inject({ kind: "lose-response", op: "put", pathname: path });
      const cancel = await jobs.cancelJob(WS, job.id);
      expect(cancel).toMatchObject({ ok: true, alreadyCancelled: false, wasRunning: true, token: "tok-1" });
    },
    RETRY_FAULT_MS,
  );
});

describe("bots on Blob when a write's answer is lost", () => {
  it(
    "hires once, and says so, when the create's answer is lost",
    async () => {
      const bots = await import("../agent/lib/bots");
      blob.inject({ kind: "lose-response", op: "put", prefix: `t/bots/${WS}/` });
      const hired = await bots.hireBot({ workspaceId: WS, hiredBy: "test", name: "Ada", role: "analyst", persona: "careful" });
      expect(hired.name).toBe("Ada");
      expect([...blob.objects.keys()].filter((path) => path.startsWith(`t/bots/${WS}/`))).toHaveLength(1);
    },
    RETRY_FAULT_MS,
  );

  it(
    "seeds the default Bot even when the seed claim's answer is lost",
    async () => {
      const bots = await import("../agent/lib/bots");
      blob.inject({ kind: "lose-response", op: "put", pathname: `t/defaults/${WS}/default-bot.json` });
      const roster = await bots.listBots(WS);
      expect(roster).toHaveLength(1);
      expect(JSON.parse(blob.text(`t/defaults/${WS}/default-bot.json`) ?? "{}")).toMatchObject({ state: "seeded" });
    },
    RETRY_FAULT_MS,
  );
});

describe("the action ledger on Blob when a write's answer is lost", () => {
  const input = {
    workspaceId: WS,
    jobId: "job-1",
    run: { token: "tok-1", session: "sess-1" },
    kind: "email.send" as const,
    target: ["a@example.com"],
    payload: { to: ["a@example.com"], subject: "Hi", body: "Hello" },
    requester: "owner",
  };

  it(
    "proposes once, begins once and settles once: a lost answer never opens a second send",
    async () => {
      const actions = await import("../agent/lib/actions");
      blob.inject({ kind: "lose-response", op: "put", prefix: `t/actions/${WS}/` });
      const proposed = await actions.proposeAction(input);
      // The create landed; reading it back finds this call's own record.
      expect(proposed.action.state).toBe("proposed");
      const path = `t/${actions.actionKey(WS, proposed.action.actionId)}`;
      expect([...blob.objects.keys()].filter((key) => key.startsWith(`t/actions/${WS}/`))).toEqual([path]);

      const now = new Date().toISOString();
      blob.inject({ kind: "lose-response", op: "put", pathname: path });
      expect(await actions.applyAction(WS, proposed.action.actionId, { type: "approve", approver: "owner", at: now })).toMatchObject({
        ok: true,
        action: { state: "approved" },
      });

      blob.inject({ kind: "lose-response", op: "put", pathname: path });
      const begun = await actions.applyAction(WS, proposed.action.actionId, { type: "begin", attemptId: "att-1", at: now });
      // The send gate in send_email: ok and this attempt's id on the record means "send".
      expect(begun).toMatchObject({ ok: true, action: { state: "executing", attemptId: "att-1", attempts: 1 } });

      // A concurrent second attempt (a replayed step) is refused: no second send.
      const second = await actions.applyAction(WS, proposed.action.actionId, { type: "begin", attemptId: "att-2", at: now });
      expect(second).toMatchObject({ ok: false, reason: "busy" });

      blob.inject({ kind: "lose-response", op: "put", pathname: path });
      const receipt = { providerId: "p-1", status: "sent", httpStatus: 200, at: now };
      expect(await actions.applyAction(WS, proposed.action.actionId, { type: "succeed", attemptId: "att-1", receipt, at: now })).toMatchObject({
        ok: true,
        action: { state: "succeeded", receipt },
      });
      expect((await actions.getAction(WS, proposed.action.actionId))?.attempts).toBe(1);
    },
    4 * RETRY_FAULT_MS,
  );
});
