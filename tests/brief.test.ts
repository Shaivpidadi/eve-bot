import { describe, expect, it } from "vitest";

import { renderBrief } from "../agent/lib/brief";
import { renderJournal, type JournalEntry } from "../agent/lib/journal";
import type { Bot, Job } from "../agent/lib/types";

/** A fresh run's brief replays what the last run recorded, so it continues instead of starting over. */

const line = (n: number, over: Partial<JournalEntry> = {}): JournalEntry => ({
  at: new Date(1_700_000_000_000 + n * 1000).toISOString(),
  runToken: "run_1",
  kind: "progress",
  text: `step ${n}`,
  ...over,
});

const bot = { name: "Atlas", emoji: "🧭", role: "Generalist", persona: "Careful.", playbook: [] } as unknown as Bot;
const job = (over: Partial<Job> = {}): Job =>
  ({
    id: "job_1",
    title: "Watch the listings",
    brief: "Look for new listings.",
    requestedBy: "operator",
    successCriteria: [],
    everyMinutes: null,
    requiresSignoff: false,
    result: null,
    feedback: null,
    ...over,
  }) as unknown as Job;

describe("renderJournal", () => {
  it("renders nothing for an empty journal", () => {
    expect(renderJournal([])).toBe("");
  });

  it("lists steps, the open page, files, decisions and what was asked", () => {
    const text = renderJournal([
      line(1, { kind: "decision", text: "Use the CSV export, the UI paginates" }),
      line(2, { kind: "page", text: "Opened listings", data: { url: "https://x/listings" } }),
      line(3, { kind: "file", text: "Wrote out.csv", data: { path: "/workspace/bots/a/out.csv" } }),
      line(4, { kind: "asked", text: "Asked a person to take over: sign in" }),
      line(5, { kind: "handover", text: "A person handed the browser back." }),
    ]);
    expect(text).toContain("## Where the last run got to");
    expect(text).toContain("(5 steps)");
    expect(text).toContain("Decisions so far:\n- Use the CSV export, the UI paginates");
    expect(text).toContain("2. [page] Opened listings");
    expect(text).toContain("Open page: https://x/listings");
    expect(text).toContain("Files written: /workspace/bots/a/out.csv");
    expect(text).toContain("Asked and answered:\n- Asked a person to take over: sign in\n- A person handed the browser back.");
  });

  it("shows only the latest steps of a long journal, numbered from where they sit", () => {
    const text = renderJournal(Array.from({ length: 300 }, (_, n) => line(n)), { limit: 30 });
    expect(text).toContain("Last 30 steps (270 earlier ones not shown):");
    expect(text).toContain("271. [progress] step 270");
    expect(text).toContain("300. [progress] step 299");
    expect(text).not.toContain("[progress] step 269\n");
  });
});

describe("renderBrief", () => {
  it("has no replay for a job nothing has worked on", () => {
    expect(renderBrief(bot, job(), { token: "run_2" })).not.toContain("Where the last run got to");
  });

  it("replays the journal before what done means", () => {
    const brief = renderBrief(bot, job({ journal: [line(1)], successCriteria: ["A list"] }), { token: "run_2" });
    expect(brief).toContain("## Where the last run got to");
    expect(brief.indexOf("Where the last run got to")).toBeLessThan(brief.indexOf("## Done means"));
    expect(brief).toContain('runToken "run_2"');
  });
});
