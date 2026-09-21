import { beforeEach, describe, expect, it, vi } from "vitest";

import { capture, cues, type CaptureDeps, type Judge, type Proposal } from "../agent/lib/memory/capture";
import { nearest, select, tokens } from "../agent/lib/memory/rank";
import { acceptable, forget, looksSecret, type MemoryEntry, pin, readEntries, remember, rewrite } from "../agent/lib/memory/store";

const entry = (text: string, extra: Partial<MemoryEntry> = {}): MemoryEntry => ({
  id: `mem_${text.length}_${text.slice(0, 4).replace(/\W/g, "")}`,
  text,
  kind: "fact",
  source: { who: "auto" },
  at: "2026-09-21T12:00:00.000Z",
  pinned: false,
  recalls: 0,
  lastRecalledAt: null,
  ...extra,
});

/** A Jev that answers from a table: question id prefix → probability. */
function tableJudge(answers: Record<string, number>, confidence = 0.95): Judge {
  return async (_state, questions) => {
    const out: Record<string, { probability: number }> = {};
    const conf: Record<string, number> = {};
    for (const id of Object.keys(questions)) {
      const key = Object.keys(answers).find((prefix) => id.startsWith(prefix) && (id === prefix || /^\d+$/.test(id.slice(prefix.length))));
      out[id] = { probability: key === undefined ? 0.5 : answers[key]! };
      conf[id] = confidence;
    }
    return { answers: out as never, confidence: conf, inputTokens: 100 };
  };
}

describe("memory store", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("BOT_STORE", "memory");
  });

  it("refuses secrets and empties, keeps the rest once, and caps a slot", () => {
    expect(looksSecret("The Gmail password is hunter2")).toBe(true);
    expect(looksSecret("Card 4111 1111 1111 1111 for invoices")).toBe(true);
    // Long numbers that are not card numbers, such as a timestamp or an order id, are fine.
    expect(looksSecret("QA fixture 1758489281186: prefers no trace")).toBe(false);
    expect(looksSecret("Order 9876543210123 shipped")).toBe(false);
    expect(looksSecret("Use token ghp_abcdefghijklmnop for GitHub")).toBe(true);
    expect(looksSecret("Prefers summaries as three bullets")).toBe(false);
    expect(acceptable({ text: "   ", kind: "fact" })).toMatchObject({ ok: false });
    expect(acceptable({ text: "  Prefers   three  bullets ", kind: "preference" })).toEqual({ ok: true, text: "Prefers three bullets" });
  });

  it("remembers with provenance, skips word-for-word repeats, and ignores a replayed operation", async () => {
    const { remember: rememberFresh, readEntries: readFresh } = await import("../agent/lib/memory/store");
    const first = await rememberFresh("ws", "profile", [{ text: "Their name is Shaishav.", kind: "fact" }, { text: "Prefers three bullets.", kind: "preference" }], { who: "auto", room: "desk" }, { operationId: "op-1" });
    expect(first.added).toHaveLength(2);
    expect(first.added[0]?.source).toEqual({ who: "auto", room: "desk" });

    const again = await rememberFresh("ws", "profile", [{ text: "prefers three bullets", kind: "preference" }, { text: "Weekly reports go out on Fridays.", kind: "rule" }], { who: "hq" }, { operationId: "op-2" });
    expect(again.added.map((added) => added.text)).toEqual(["Weekly reports go out on Fridays."]);
    expect(again.duplicates).toBe(1);

    const replay = await rememberFresh("ws", "profile", [{ text: "Something new.", kind: "fact" }], { who: "auto" }, { operationId: "op-1" });
    expect(replay).toEqual({ added: [], duplicates: 0, refused: 0, replayed: true });
    expect(await readFresh("ws", "profile")).toHaveLength(3);
    // Another workspace sees nothing of it.
    expect(await readFresh("other", "profile")).toHaveLength(0);
  });

  it("pins, rewrites, and forgets by id", async () => {
    const saved = await remember("ws2", "team", [{ text: "Invoices over $5,000 need Priya's approval.", kind: "rule" }], { who: "you", name: "operator" });
    const id = saved.added[0]!.id;
    expect(await pin("ws2", "team", id, true)).toEqual({ ok: true });
    expect((await readEntries("ws2", "team"))[0]?.pinned).toBe(true);
    expect(await rewrite("ws2", "team", id, "Invoices over $10,000 need Priya's approval.")).toEqual({ ok: true });
    expect(await rewrite("ws2", "team", id, "password: hunter2")).toMatchObject({ ok: false, status: 400 });
    expect(await forget("ws2", "team", "mem_nope")).toMatchObject({ ok: false, status: 404 });
    expect(await forget("ws2", "team", id)).toEqual({ ok: true });
    expect(await readEntries("ws2", "team")).toHaveLength(0);
  });
});

describe("recall ranking", () => {
  const entries = [
    entry("Their name is Shaishav.", { kind: "fact" }),
    entry("Prefers summaries as three bullets.", { kind: "preference" }),
    entry("Always cc finance@example.com on invoice emails.", { kind: "rule" }),
    entry("Weekly reports go out on Fridays.", { kind: "rule" }),
    entry("Export the CRM report as CSV; the PDF drops rows.", { kind: "lesson", pinned: true }),
  ];

  it("tokenises without stop words and keeps addresses whole", () => {
    expect(tokens("Always cc finance@example.com on the invoice")).toEqual(["always", "finance@example.com", "invoice"]);
  });

  it("brings every preference, rule and fact whatever the message says, and ranks the rest", () => {
    const picked = select(entries, "Draft a two-line note to the board about the Q2 meeting");
    expect(picked.core[0]?.text).toBe("Export the CRM report as CSV; the PDF drops rows.");
    expect(picked.core.map((row) => row.text)).toContain("Prefers summaries as three bullets.");
    expect(picked.core.map((row) => row.text)).toContain("Always cc finance@example.com on invoice emails.");
    expect(picked.relevant).toEqual([]);
    // Lessons are ranked, not always shown: only the one about invoices comes for an invoice question.
    const lessons = [
      entry("Export the CRM report as CSV; the PDF drops rows.", { kind: "lesson" }),
      entry("The invoice tool hides Send under More.", { kind: "lesson" }),
      entry("Gmail's archive button is under the kebab menu.", { kind: "lesson" }),
    ];
    const craft = select(lessons, "Send the invoice to the client", { coreKinds: [] });
    expect(craft.core).toEqual([]);
    expect(craft.relevant.map((row) => row.text)).toEqual(["The invoice tool hides Send under More."]);
    // No message: the most recent entries stand in.
    expect(select(lessons, "", { coreKinds: [] }).relevant).toHaveLength(3);
  });

  it("keeps the core inside the budget, newest first", () => {
    const many = Array.from({ length: 80 }, (_, index) => entry(`Rule number ${index} about something long enough to cost a little space.`, { kind: "rule", at: `2026-01-${String((index % 28) + 1).padStart(2, "0")}T00:00:00.000Z` }));
    const picked = select(many, "", { maxChars: 1_000 });
    const chars = picked.core.reduce((sum, row) => sum + row.text.length + 3, 0);
    expect(chars).toBeLessThanOrEqual(800);
    expect(picked.core.length).toBeGreaterThan(5);
    expect(picked.core[0]!.at >= picked.core[picked.core.length - 1]!.at).toBe(true);
  });

  it("finds the nearest wording for the duplicate check", () => {
    expect(nearest(entries, "cc the finance mailbox on every invoice", 1)[0]?.text).toBe("Always cc finance@example.com on invoice emails.");
    expect(nearest(entries, "", 3)).toEqual([]);
  });
});

describe("capture with Jev as the gatekeeper", () => {
  beforeEach(() => {
    vi.stubEnv("BOT_STORE", "memory");
  });

  const proposals: Proposal[] = [
    { text: "Prefers summaries as three bullets.", kind: "preference", slot: "profile" },
    { text: "Asked for the Q3 report today.", kind: "fact", slot: "profile" },
    { text: "Invoices need approval from Priya.", kind: "rule", slot: "team" },
  ];
  const deps = (judge: Judge | null, existing: readonly MemoryEntry[] = []): CaptureDeps => ({
    judge,
    extract: async () => proposals,
    floor: 0.7,
    existing: async () => existing,
  });
  const input = (person: string, workspaceId = `ws-${Math.random().toString(36).slice(2, 8)}`) => ({
    workspaceId,
    mode: "conversation" as const,
    person,
    reply: "Noted.",
    source: { who: "auto" as const, room: "desk" },
    operationId: `op-${Math.random().toString(36).slice(2, 8)}`,
  });

  it("stops at the gate when Jev says nothing durable was said", async () => {
    let extracted = 0;
    const result = await capture(input("Please run the inbox review now."), { ...deps(tableJudge({ worth: 0.05 })), extract: async () => (extracted += 1, proposals) });
    expect(result).toEqual({ gate: "closed", proposed: 0, saved: [] });
    expect(extracted).toBe(0);
  });

  it("keeps what Jev validates and drops the one-off, then refuses a replay", async () => {
    const judge = tableJudge({ worth: 0.95, durable0: 0.95, about0: 0.95, safe0: 0.95, durable1: 0.05, about1: 0.9, safe1: 0.95, durable2: 0.9, about2: 0.9, safe2: 0.95 });
    const first = input("I prefer every summary as three bullets, and invoices need Priya's approval.");
    const result = await capture(first, deps(judge));
    expect(result.gate).toBe("jev");
    expect(result.proposed).toBe(3);
    expect(result.saved.map((row) => [row.slot, row.text])).toEqual([
      ["profile", "Prefers summaries as three bullets."],
      ["team", "Invoices need approval from Priya."],
    ]);
    const replay = await capture(first, deps(judge));
    expect(replay.saved).toEqual([]);
  });

  it("drops a proposal Jev calls a duplicate of something stored", async () => {
    const stored = [entry("Likes summaries as exactly three bullets.", { kind: "preference" })];
    const judge = tableJudge({ worth: 0.95, durable: 0.95, about: 0.95, safe: 0.95, same0: 0.95, same1: 0.05, same2: 0.05 });
    const result = await capture(input("Three bullets for summaries please, always."), deps(judge, stored));
    expect(result.saved.map((row) => row.text)).not.toContain("Prefers summaries as three bullets.");
  });

  it("without Jev, opens on cues in the wording and otherwise stays shut", async () => {
    expect(cues("I prefer short answers")).toBe(true);
    expect(cues("Run the report")).toBe(false);
    const shut = await capture(input("Run the inbox review and tell me what came in."), deps(null));
    expect(shut.gate).toBe("closed");
    const open = await capture(input("From now on I prefer summaries as three bullets."), deps(null));
    expect(open.gate).toBe("cues");
    expect(open.saved.length).toBe(3);
  });

  it("never lets a secret through, whatever the extractor proposed", async () => {
    const leaky: CaptureDeps = {
      ...deps(null),
      extract: async () => [{ text: "Their Gmail password is hunter2.", kind: "fact", slot: "profile" }],
    };
    const result = await capture(input("Remember my Gmail password is hunter2"), leaky);
    expect(result.saved).toEqual([]);
  });
});
