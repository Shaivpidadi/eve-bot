import { beforeEach, describe, expect, it, vi } from "vitest";

import { appended, capped, filesWritten, KEEP_HEAD, KEEP_TAIL, lastPage, MAX_ENTRIES, MAX_ERRORS_PER_RUN, type JournalEntry } from "../agent/lib/journal";

/**
 * The journal is the portable half of a session log: a fresh run must be able
 * to trust it, so it never holds a step twice, never grows without bound, and
 * only the run that owns the job may write to it.
 */

const WORKSPACE = "default";
const run = { token: "run_1" };
const entry = (n: number, over: Partial<JournalEntry> = {}): JournalEntry => ({
  at: new Date(1_700_000_000_000 + n * 1000).toISOString(),
  runToken: "run_1",
  kind: "progress",
  text: `step ${n}`,
  ...over,
});

describe("appended", () => {
  it("adds a line stamped with the run and the time", () => {
    const journal = appended([], run, { kind: "page", text: "Opened the listings", data: { url: "https://x/l" }, at: "2026-10-13T10:00:00.000Z" });
    expect(journal).toEqual([{ at: "2026-10-13T10:00:00.000Z", runToken: "run_1", kind: "page", text: "Opened the listings", data: { url: "https://x/l" } }]);
  });

  it("writes nothing for a line already there, whatever its time", () => {
    const first = appended([], run, { kind: "progress", text: "Read the inbox", at: "2026-10-13T10:00:00.000Z" })!;
    expect(appended(first, run, { kind: "progress", text: "Read the inbox", at: "2026-10-13T10:00:05.000Z" })).toBeNull();
    // Same words from another run are that run's own step.
    expect(appended(first, { token: "run_2" }, { kind: "progress", text: "Read the inbox" })).toHaveLength(2);
    // Same words with different data are different steps.
    expect(appended(first, run, { kind: "progress", text: "Read the inbox", data: { count: 3 } })).toHaveLength(2);
  });

  it("stops a run flooding the record with errors", () => {
    let journal: JournalEntry[] = [];
    for (let n = 0; n < MAX_ERRORS_PER_RUN + 5; n += 1) {
      const next = appended(journal, run, { kind: "error", text: `boom ${n}` });
      if (next !== null) journal = next;
    }
    expect(journal.filter((line) => line.kind === "error")).toHaveLength(MAX_ERRORS_PER_RUN);
    // Another run gets its own allowance; progress is never dropped.
    expect(appended(journal, { token: "run_2" }, { kind: "error", text: "boom" })).toHaveLength(MAX_ERRORS_PER_RUN + 1);
    expect(appended(journal, run, { kind: "progress", text: "still going" })).toHaveLength(MAX_ERRORS_PER_RUN + 1);
  });
});

describe("capped", () => {
  it("keeps the head and the tail and says how many steps were folded", () => {
    const lines = Array.from({ length: MAX_ENTRIES + 10 }, (_, n) => entry(n));
    const kept = capped(lines);
    expect(kept).toHaveLength(MAX_ENTRIES + 1);
    expect(kept.slice(0, KEEP_HEAD)).toEqual(lines.slice(0, KEEP_HEAD));
    expect(kept.slice(-KEEP_TAIL)).toEqual(lines.slice(-KEEP_TAIL));
    expect(kept[KEEP_HEAD]).toMatchObject({ kind: "progress", text: "10 earlier steps folded", data: { folded: 10 } });
  });

  it("grows the fold instead of stacking markers", () => {
    const lines = Array.from({ length: MAX_ENTRIES + 10 }, (_, n) => entry(n));
    const once = capped(lines);
    const twice = capped([...once, ...Array.from({ length: 5 }, (_, n) => entry(1000 + n))]);
    const folds = twice.filter((line) => line.text.endsWith("earlier steps folded"));
    expect(folds).toHaveLength(1);
    expect(folds[0]?.data?.folded).toBe(15);
    expect(twice).toHaveLength(MAX_ENTRIES + 1);
  });

  it("leaves a short journal alone", () => {
    const lines = [entry(1), entry(2)];
    expect(capped(lines)).toEqual(lines);
  });
});

describe("what the next run reads", () => {
  it("finds the last page and the files written, each once", () => {
    const journal = [
      entry(1, { kind: "page", text: "Opened a", data: { url: "https://a", title: "A" } }),
      entry(2, { kind: "file", text: "Wrote x", data: { path: "/workspace/bots/x.txt" } }),
      entry(3, { kind: "page", text: "Opened b", data: { url: "https://b" } }),
      entry(4, { kind: "file", text: "Wrote y", data: { path: "/workspace/bots/y.txt" } }),
      entry(5, { kind: "file", text: "Rewrote x", data: { path: "/workspace/bots/x.txt" } }),
    ];
    expect(lastPage(journal)).toEqual({ url: "https://b", title: null });
    expect(filesWritten(journal)).toEqual(["/workspace/bots/y.txt", "/workspace/bots/x.txt"]);
    expect(lastPage([])).toBeNull();
  });
});

describe("appendJournal", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("BOT_STORE", "memory");
  });

  it("writes under the run fence and reads back on the job", async () => {
    const jobs = await import("../agent/lib/jobs");
    const job = await jobs.assignJob({ workspaceId: WORKSPACE, botId: "bot_1", requestedBy: "operator", title: "Diary", brief: "Keep one." });
    // Nobody owns it yet: refused, nothing written.
    expect((await jobs.appendJournal(WORKSPACE, job.id, "sess_A", { kind: "progress", text: "early" })).ok).toBe(false);

    expect((await jobs.claimJob(WORKSPACE, job.id, { token: "run_1", forMs: 60_000, status: "running", kind: "run" })).ok).toBe(true);
    expect((await jobs.bindRun(WORKSPACE, job.id, "run_1", "sess_A")).ok).toBe(true);
    const written = await jobs.appendJournal(WORKSPACE, job.id, "sess_A", { kind: "page", text: "Opened the inbox", data: { url: "https://mail" } });
    expect(written.ok && written.job.journal).toMatchObject([{ runToken: "run_1", kind: "page", text: "Opened the inbox", data: { url: "https://mail" } }]);

    // A replayed write is the record's own, and a superseded session writes nothing.
    expect((await jobs.appendJournal(WORKSPACE, job.id, "sess_A", { kind: "page", text: "Opened the inbox", data: { url: "https://mail" } })).ok).toBe(true);
    expect((await jobs.appendJournal(WORKSPACE, job.id, "sess_B", { kind: "progress", text: "not mine" })).ok).toBe(false);
    expect((await jobs.getJob(WORKSPACE, job.id))?.journal).toHaveLength(1);
  });

  it("reads an older job as having an empty journal", async () => {
    const { journalOf } = await import("../agent/lib/journal");
    expect(journalOf({})).toEqual([]);
  });
});
