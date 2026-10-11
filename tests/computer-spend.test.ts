import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { computerRates, computerSessionCost } from "../agent/lib/pricing";
import { FakeBlobService, useFakeBlobEnv } from "./blob-fake";

/**
 * The computer's runtime on the workspace budget: priced from the owner's
 * rates (never an assumed one), charged per finished Vercel Sandbox session,
 * each exactly once however often the sweep runs, and on Blob even when a
 * write's answer is lost.
 */

const HOUR = 60 * 60_000;
const env = (vars: Record<string, string>) => vars as NodeJS.ProcessEnv;
const NOW = new Date("2026-10-11T12:00:00Z");

describe("computer rates", () => {
  it("assumes no rate: unset means unknown, not free", () => {
    expect(computerRates(env({}))).toBeNull();
    expect(computerSessionCost({ id: "s", durationMs: HOUR, activeCpuMs: HOUR, memoryMb: 8192 }, null)).toBeNull();
  });

  it("reads each rate and ignores a bad one", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(computerRates(env({ BOT_COMPUTER_USD_PER_HOUR: "0.5" }))).toEqual({ perHour: 0.5, perCpuHour: null, perGbHour: null });
    expect(computerRates(env({ BOT_COMPUTER_USD_PER_CPU_HOUR: "2", BOT_COMPUTER_USD_PER_GB_HOUR: " 0.01 " }))).toEqual({
      perHour: null,
      perCpuHour: 2,
      perGbHour: 0.01,
    });
    expect(computerRates(env({ BOT_COMPUTER_USD_PER_HOUR: "0" }))).toEqual({ perHour: 0, perCpuHour: null, perGbHour: null });
    expect(computerRates(env({ BOT_COMPUTER_USD_PER_HOUR: "lots" }))).toBeNull();
    expect(computerRates(env({ BOT_COMPUTER_USD_PER_HOUR: "-1" }))).toBeNull();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("sums the parts that are set", () => {
    const session = { id: "s", durationMs: 2 * HOUR, activeCpuMs: HOUR / 2, memoryMb: 8192 };
    expect(computerSessionCost(session, { perHour: 0.5, perCpuHour: null, perGbHour: null })).toBeCloseTo(1);
    expect(computerSessionCost(session, { perHour: null, perCpuHour: 2, perGbHour: null })).toBeCloseTo(1);
    expect(computerSessionCost(session, { perHour: null, perCpuHour: null, perGbHour: 0.01 })).toBeCloseTo(0.16);
    expect(computerSessionCost(session, { perHour: 0.5, perCpuHour: 2, perGbHour: 0.01 })).toBeCloseTo(2.16);
  });

  it("is unknown when a rate that is set needs a figure Vercel did not report", () => {
    const noCpu = { id: "s", durationMs: HOUR, activeCpuMs: undefined, memoryMb: 2048 };
    expect(computerSessionCost(noCpu, { perHour: null, perCpuHour: 2, perGbHour: null })).toBeNull();
    expect(computerSessionCost(noCpu, { perHour: 1, perCpuHour: null, perGbHour: null })).toBeCloseTo(1);
    expect(computerSessionCost({ ...noCpu, durationMs: undefined }, { perHour: 1, perCpuHour: null, perGbHour: null })).toBeNull();
  });
});

type Session = import("../agent/lib/computer-spend").SessionRecord;

const session = (id: string, stoppedAt: string, extra: Partial<Session> = {}): Session => ({
  id,
  status: "stopped",
  memory: 8192,
  createdAt: Date.parse(stoppedAt) - 2 * HOUR,
  startedAt: Date.parse(stoppedAt) - 2 * HOUR,
  stoppedAt: Date.parse(stoppedAt),
  duration: 2 * HOUR,
  activeCpuDurationMs: HOUR / 2,
  ...extra,
});

const listing = (sessions: readonly Session[]) => async function* () {
  yield* [...sessions].sort((a, b) => b.createdAt - a.createdAt);
};

describe.each(["memory", "blob"] as const)("charging the computer on the %s store", (backend) => {
  const blob = new FakeBlobService();
  beforeAll(() => (backend === "blob" ? blob.start() : undefined));
  afterAll(() => (backend === "blob" ? blob.stop() : undefined));

  beforeEach(() => {
    vi.resetModules();
    blob.reset();
    if (backend === "blob") useFakeBlobEnv("c");
    else vi.stubEnv("BOT_STORE", "memory");
    vi.stubEnv("BOT_BUDGET_MONTHLY_USD", "");
    vi.stubEnv("BOT_BUDGET_DAILY_USD", "");
    vi.stubEnv("BOT_COMPUTER_USD_PER_HOUR", "0.5");
    vi.stubEnv("BOT_COMPUTER_USD_PER_CPU_HOUR", "");
    vi.stubEnv("BOT_COMPUTER_USD_PER_GB_HOUR", "");
    vi.stubEnv("BOT_DEFAULT_WORKSPACE", "");
  });

  const load = async () => ({ spend: await import("../agent/lib/computer-spend"), budget: await import("../agent/lib/budget") });

  it("charges each finished session once, to the workspace, in the month it stopped", async () => {
    const { spend, budget } = await load();
    const sessions = [
      session("s-sep", "2026-09-30T23:00:00Z"),
      session("s-oct-1", "2026-10-02T10:00:00Z"),
      session("s-oct-2", "2026-10-10T10:00:00Z", { duration: undefined }),
      session("s-running", "2026-10-11T11:00:00Z", { status: "running", stoppedAt: undefined, duration: undefined }),
      session("s-old", "2026-08-15T10:00:00Z"),
    ];
    expect(await spend.chargeComputerRuntime({ now: NOW, sessions: listing(sessions), workspaceId: "default" })).toBe(3);
    // Swept again, and again: nothing more.
    expect(await spend.chargeComputerRuntime({ now: NOW, sessions: listing(sessions), workspaceId: "default" })).toBe(0);

    const october = await budget.readBudget("default", "2026-10");
    // Two hours at $0.50, twice; the session with no duration uses its start and stop.
    expect(october.spentUsd).toBe(2);
    expect(october.byCategory.computer).toEqual({ spentUsd: 2, unknownCostCount: 0 });
    expect(october.computerSessions).toEqual({ "s-oct-1": 1, "s-oct-2": 1 });
    expect(october.days["2026-10-02"]).toBe(1);
    expect(october.reservedUsd).toBe(0);
    const september = await budget.readBudget("default", "2026-09");
    expect(september.computerSessions).toEqual({ "s-sep": 1 });
    expect((await budget.readBudget("default", "2026-08")).computerSessions).toBeUndefined();

    // It stops: the next sweep charges it, and only it.
    const stopped = sessions.map((entry) =>
      entry.id === "s-running" ? session("s-running", "2026-10-11T11:30:00Z", { duration: HOUR }) : entry,
    );
    expect(await spend.chargeComputerRuntime({ now: NOW, sessions: listing(stopped), workspaceId: "default" })).toBe(1);
    expect((await budget.readBudget("default", "2026-10")).spentUsd).toBe(2.5);
  });

  it("counts sessions as unknown cost without a rate, and says the runtime is unpriced", async () => {
    vi.stubEnv("BOT_COMPUTER_USD_PER_HOUR", "");
    const { spend, budget } = await load();
    await spend.chargeComputerRuntime({ now: NOW, sessions: listing([session("s-1", "2026-10-05T10:00:00Z")]), workspaceId: "default" });
    const doc = await budget.readBudget("default", "2026-10");
    expect(doc.spentUsd).toBe(0);
    expect(doc.unknownCostCount).toBe(1);
    expect(doc.computerSessions).toEqual({ "s-1": null });
    expect((await budget.budgetStatus("default", NOW)).unpriced).toEqual(budget.UNPRICED);
    vi.stubEnv("BOT_COMPUTER_USD_PER_HOUR", "0.5");
    expect((await budget.budgetStatus("default", NOW)).unpriced).toEqual([]);
  });

  it("does not let concurrent sweeps charge a session twice", async () => {
    const { spend, budget } = await load();
    const sessions = listing([session("s-1", "2026-10-05T10:00:00Z"), session("s-2", "2026-10-06T10:00:00Z")]);
    const results = await Promise.all(
      Array.from({ length: 4 }, () => spend.chargeComputerRuntime({ now: NOW, sessions, workspaceId: "default" })),
    );
    expect(results.reduce((sum, count) => sum + count, 0)).toBe(2);
    expect((await budget.readBudget("default", "2026-10")).spentUsd).toBe(2);
  });

  it("counts the runtime against the limit that admits runs", async () => {
    const { spend, budget } = await load();
    vi.stubEnv("BOT_BUDGET_MONTHLY_USD", "3");
    await spend.chargeComputerRuntime({
      now: NOW,
      sessions: listing([session("s-1", "2026-10-05T10:00:00Z", { duration: 4 * HOUR })]),
      workspaceId: "default",
    });
    const admission = await budget.admitRun("default", "run-1", 1.5, { jobId: "job-1", now: NOW });
    expect(admission).toMatchObject({ ok: false, refusal: "limit" });
  });

  it.runIf(backend === "blob")(
    "charges once when the charge's answer is lost and the SDK retries into it",
    async () => {
      const { spend, budget } = await load();
      const sessions = listing([session("s-1", "2026-10-05T10:00:00Z")]);
      blob.inject({ kind: "lose-response", op: "put", pathname: "c/budget/default/2026-10.json" });
      await spend.chargeComputerRuntime({ now: NOW, sessions, workspaceId: "default" });
      expect(await spend.chargeComputerRuntime({ now: NOW, sessions, workspaceId: "default" })).toBe(0);
      const doc = await budget.readBudget("default", "2026-10");
      expect(doc.spentUsd).toBe(1);
      expect(doc.computerSessions).toEqual({ "s-1": 1 });
      expect(blob.requests("put", "c/budget/default/2026-10.json").map((entry) => entry.status)).toEqual(["dropped", 400]);
    },
    20_000,
  );
});

describe("the sweep outside Vercel", () => {
  it("charges nothing for a local computer and never asks Vercel", async () => {
    vi.resetModules();
    vi.stubEnv("BOT_STORE", "memory");
    vi.stubEnv("BOT_COMPUTER", "local");
    const { chargeComputerRuntime } = await import("../agent/lib/computer-spend");
    expect(await chargeComputerRuntime({ now: NOW })).toBe(0);
  });
});
