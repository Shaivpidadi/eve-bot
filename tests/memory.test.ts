import { beforeEach, describe, expect, it, vi } from "vitest";

import { capture, cues, type CaptureDeps, existingFor, type Judge, type Proposal } from "../agent/lib/memory/capture";
import { renderCore } from "../agent/lib/memory/provider";
import { nearest, select, tokens } from "../agent/lib/memory/rank";
import { acceptable, applyOperations, confidenceOf, confirm, FADE_AFTER_MS, FIELDS, forget, isFaded, liveEntries, looksSecret, type MemoryEntry, pin, readEntries, readFields, readForgotten, recallable, remember, resolveField, restore, revive, rewrite, setField } from "../agent/lib/memory/store";

const entry = (text: string, extra: Partial<MemoryEntry> = {}): MemoryEntry => ({
  id: `mem_${text.replace(/\W/g, "").slice(0, 48)}`,
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

  it("applies adds, rewordings with history, and retirements in one write, and can bring a retired entry back", async () => {
    const first = await applyOperations("ws3", "profile", [{ op: "add", text: "Prefers summaries as three bullets.", kind: "preference" }, { op: "add", text: "Lives in Boston.", kind: "fact" }], { who: "auto" }, { operationId: "t1" });
    const [bullets, boston] = first.added;
    expect(first.added).toHaveLength(2);

    const second = await applyOperations(
      "ws3",
      "profile",
      [
        { op: "update", id: bullets!.id, text: "Prefers summaries as five bullets." },
        { op: "retire", id: boston!.id, reason: "They said they moved to Austin." },
        { op: "add", text: "Lives in Austin.", kind: "fact" },
        { op: "update", id: "mem_missing", text: "Nothing." },
        { op: "add", text: "prefers summaries as five bullets", kind: "preference" },
      ],
      { who: "auto", room: "desk" },
      { operationId: "t2" },
    );
    expect(second.updated.map((entry) => entry.text)).toEqual(["Prefers summaries as five bullets."]);
    expect(second.updated[0]?.history?.[0]?.text).toBe("Prefers summaries as three bullets.");
    expect(second.retired.map((entry) => entry.text)).toEqual(["Lives in Boston."]);
    expect(second.added.map((entry) => entry.text)).toEqual(["Lives in Austin."]);
    // The duplicate of the just-reworded entry is caught against the new wording.
    expect(second.duplicates).toBe(1);

    const all = await readEntries("ws3", "profile");
    expect(all).toHaveLength(3);
    expect(liveEntries(all).map((entry) => entry.text).sort()).toEqual(["Lives in Austin.", "Prefers summaries as five bullets."]);
    expect(all.find((entry) => entry.id === boston!.id)?.retired?.reason).toBe("They said they moved to Austin.");

    // A replay writes nothing; a restore brings the retired entry back to life.
    expect((await applyOperations("ws3", "profile", [{ op: "add", text: "Anything.", kind: "fact" }], { who: "auto" }, { operationId: "t2" })).replayed).toBe(true);
    expect(await restore("ws3", "profile", boston!.id)).toEqual({ ok: true });
    expect(liveEntries(await readEntries("ws3", "profile"))).toHaveLength(3);
  });

  it("does not put back what a person forgot by hand", async () => {
    const saved = await remember("ws5", "team", [{ text: "Invoices need approval from Priya.", kind: "rule" }], { who: "auto" });
    expect(await forget("ws5", "team", saved.added[0]!.id)).toEqual({ ok: true });
    expect((await readForgotten("ws5", "team")).map((item) => item.text)).toEqual(["Invoices need approval from Priya."]);
    const again = await remember("ws5", "team", [{ text: "invoices need approval from Priya", kind: "rule" }, { text: "Marco approves invoices now.", kind: "rule" }], { who: "auto" });
    expect(again.added.map((entry) => entry.text)).toEqual(["Marco approves invoices now."]);
    expect(again.duplicates).toBe(1);
  });

  it("carries how sure the team is: by who saved it, by what Jev thought, and rising when said again", async () => {
    const saved = await applyOperations(
      "ws6",
      "profile",
      [
        { op: "add", text: "Prefers three bullets.", kind: "preference" },
        { op: "add", text: "Lives in Austin.", kind: "fact", confidence: 0.62 },
      ],
      { who: "auto" },
    );
    expect(saved.added.map((entry) => entry.confidence)).toEqual([0.7, 0.62]);
    expect(confidenceOf({ source: { who: "you" } })).toBe(1);
    expect(confidenceOf({ source: { who: "import" } })).toBe(0.75);
    await confirm("ws6", "profile", [saved.added[1]!.id], new Date("2026-09-23T12:00:00.000Z"));
    const after = (await readEntries("ws6", "profile")).find((entry) => entry.id === saved.added[1]!.id)!;
    expect(after.confidence).toBe(0.72);
    expect(after.lastConfirmedAt).toBe("2026-09-23T12:00:00.000Z");
    // Confidence never runs past one.
    for (let index = 0; index < 5; index += 1) await confirm("ws6", "profile", [after.id]);
    expect((await readEntries("ws6", "profile")).find((entry) => entry.id === after.id)!.confidence).toBe(1);
  });

  it("fades what nobody needed for ninety days, keeps pinned entries, and brings one back on request", async () => {
    const now = Date.parse("2026-09-23T12:00:00.000Z");
    const old = new Date(now - FADE_AFTER_MS - 1000).toISOString();
    const fresh = entry("Fresh.", { at: new Date(now - 1000).toISOString() });
    const stale = entry("Stale.", { at: old, lastRecalledAt: old });
    const pinned = entry("Pinned.", { at: old, pinned: true });
    const confirmedLately = entry("Confirmed.", { at: old, lastConfirmedAt: new Date(now - 1000).toISOString() });
    expect(isFaded(stale, now)).toBe(true);
    expect(isFaded(fresh, now)).toBe(false);
    expect(isFaded(pinned, now)).toBe(false);
    expect(isFaded(confirmedLately, now)).toBe(false);
    expect(recallable([fresh, stale, pinned, confirmedLately], now).map((row) => row.text)).toEqual(["Fresh.", "Pinned.", "Confirmed."]);

    const saved = await applyOperations("ws7", "craft", [{ op: "add", text: "An old lesson.", kind: "lesson" }], { who: "auto" }, { now: new Date(old) });
    const id = saved.added[0]!.id;
    expect(recallable(await readEntries("ws7", "craft"), now)).toEqual([]);
    expect(await revive("ws7", "craft", id)).toEqual({ ok: true });
    expect(recallable(await readEntries("ws7", "craft"), Date.now()).map((row) => row.id)).toEqual([id]);
  });

  it("keeps the typed core as fields: set overwrites with history, clears on empty, refuses unknown fields and secrets", async () => {
    expect(FIELDS.profile.map((field) => field.key)).toContain("timezone");
    expect(FIELDS.craft).toEqual([]);
    // Models name fields loosely; the key, the label, or either without punctuation all resolve.
    expect(resolveField("profile", "Time format")?.key).toBe("timeFormat");
    expect(resolveField("profile", "time_format")?.key).toBe("timeFormat");
    expect(resolveField("profile", "Times")?.key).toBe("timeFormat");
    expect(resolveField("team", "Always cc")?.key).toBe("cc");
    expect(resolveField("profile", "shoe size")).toBeUndefined();
    const loose = await applyOperations("ws4b", "profile", [{ op: "set", field: "Time format", value: "24-hour" }], { who: "auto" });
    expect(loose.fields).toEqual([{ field: "timeFormat", value: "24-hour", previous: null }]);
    const first = await applyOperations("ws4", "profile", [{ op: "set", field: "name", value: " Shaishav " }, { op: "set", field: "nope", value: "x" }, { op: "set", field: "timezone", value: "America/New_York" }], { who: "auto" }, { operationId: "f1" });
    expect(first.fields).toEqual([
      { field: "name", value: "Shaishav", previous: null },
      { field: "timezone", value: "America/New_York", previous: null },
    ]);
    const second = await applyOperations("ws4", "profile", [{ op: "set", field: "timezone", value: "America/Chicago" }, { op: "set", field: "name", value: "Shaishav" }], { who: "hq" }, { operationId: "f2" });
    expect(second.fields).toEqual([{ field: "timezone", value: "America/Chicago", previous: "America/New_York" }]);
    const fields = await readFields("ws4", "profile");
    expect(fields.timezone?.value).toBe("America/Chicago");
    expect(fields.timezone?.history?.[0]?.value).toBe("America/New_York");
    expect(fields.name?.source.who).toBe("auto");

    expect(await setField("ws4", "profile", "spelling", "British", { who: "you" })).toEqual({ ok: true });
    expect(await setField("ws4", "profile", "spelling", "password: hunter2", { who: "you" })).toMatchObject({ ok: false, status: 400 });
    expect(await setField("ws4", "profile", "shoeSize", "44", { who: "you" })).toMatchObject({ ok: false, status: 404 });
    expect(await setField("ws4", "profile", "name", "", { who: "you" })).toEqual({ ok: true });
    expect(Object.keys(await readFields("ws4", "profile")).sort()).toEqual(["spelling", "timezone"]);
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
    expect(tokens("Always cc finance@example.com on the invoices")).toEqual(["always", "finance@example.com", "invoice"]);
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
    { op: "add", text: "Prefers summaries as three bullets.", kind: "preference", slot: "profile" },
    { op: "add", text: "Asked for the Q3 report today.", kind: "fact", slot: "profile" },
    { op: "add", text: "Invoices need approval from Priya.", kind: "rule", slot: "team" },
  ];
  const deps = (judge: Judge | null, existing: readonly MemoryEntry[] = [], extract?: CaptureDeps["extract"]): CaptureDeps => ({
    judge,
    extract: extract ?? (async () => proposals),
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
    const result = await capture(input("Please run the inbox review now."), deps(tableJudge({ worth: 0.05 }), [], async () => (extracted += 1, proposals)));
    expect(result).toEqual({ gate: "closed", proposed: 0, saved: [], updated: [], retired: [], fields: [], confirmed: [] });
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

  it("drops a proposal Jev calls a duplicate of something stored, and counts it as confirming that entry", async () => {
    const stored = [entry("Likes summaries as exactly three bullets.", { kind: "preference" })];
    const judge = tableJudge({ worth: 0.95, durable: 0.95, about: 0.95, safe: 0.95, same0: 0.95, same1: 0.05, same2: 0.05 });
    const confirmed: string[] = [];
    const result = await capture(input("Three bullets for summaries please, always."), { ...deps(judge, stored), confirm: async (_slot, ids) => void confirmed.push(...ids) });
    expect(result.saved.map((row) => row.text)).not.toContain("Prefers summaries as three bullets.");
    expect(result.confirmed).toEqual([stored[0]!.id]);
    expect(confirmed).toEqual([stored[0]!.id]);
  });

  it("lets the extractor confirm a restated note outright, which needs no judge", async () => {
    const ws = `ws-${Math.random().toString(36).slice(2, 8)}`;
    const seeded = await applyOperations(ws, "team", [{ op: "add", text: "Weekly reports go out on Fridays.", kind: "rule" }], { who: "import" });
    const id = seeded.added[0]!.id;
    const result = await capture(input("As I said, the weekly report goes out every Friday.", ws), {
      judge: null,
      extract: async () => [{ op: "confirm", id, slot: "team" }],
      floor: 0.7,
      existing: (slot) => readEntries(ws, slot),
    });
    expect(result.confirmed).toEqual([id]);
    const after = (await readEntries(ws, "team"))[0]!;
    expect(after.confidence).toBe(0.85);
    expect(after.lastConfirmedAt).not.toBeNull();
  });

  it("sets a new entry's confidence from what Jev thought of it", async () => {
    const judge = tableJudge({ worth: 0.95, durable0: 0.9, about0: 0.8, safe0: 0.99, durable1: 0.05, about1: 0.9, safe1: 0.95, durable2: 0.7, about2: 0.72, safe2: 0.95 });
    const result = await capture(input("I prefer every summary as three bullets, and invoices need Priya's approval."), deps(judge));
    expect(result.saved.map((row) => row.confidence)).toEqual([0.85, 0.71]);
    // Without Jev, the source decides.
    const plain = await capture(input("From now on I prefer summaries as three bullets."), deps(null));
    expect(plain.saved.every((row) => row.confidence === 0.7)).toBe(true);
  });

  it("rewords an entry when the person's preference moved on, keeping the old wording, and retires what they say is gone", async () => {
    const ws = `ws-${Math.random().toString(36).slice(2, 8)}`;
    const seeded = await applyOperations(ws, "profile", [{ op: "add", text: "Prefers summaries as three bullets.", kind: "preference" }, { op: "add", text: "Lives in Boston.", kind: "fact" }], { who: "you" });
    const [bullets, boston] = seeded.added;
    const changes: Proposal[] = [
      { op: "update", id: bullets!.id, text: "Prefers summaries as five bullets.", slot: "profile" },
      { op: "retire", id: boston!.id, reason: "They moved to Austin.", slot: "profile" },
      { op: "add", text: "Lives in Austin.", kind: "fact", slot: "profile" },
    ];
    const judge = tableJudge({ worth: 0.95, supersedes0: 0.92, safe0: 0.99, gone1: 0.9, durable2: 0.9, about2: 0.95, safe2: 0.99, same: 0.05 });
    const result = await capture(
      { ...input("Make it five bullets from now on, not three. Also I moved to Austin.", ws) },
      { judge, extract: async () => changes, floor: 0.7, existing: (slot) => readEntries(ws, slot) },
    );
    expect(result.updated.map((row) => row.text)).toEqual(["Prefers summaries as five bullets."]);
    expect(result.updated[0]?.history?.[0]?.text).toBe("Prefers summaries as three bullets.");
    expect(result.retired.map((row) => row.text)).toEqual(["Lives in Boston."]);
    expect(result.saved.map((row) => row.text)).toEqual(["Lives in Austin."]);
    expect(liveEntries(await readEntries(ws, "profile")).map((row) => row.text).sort()).toEqual(["Lives in Austin.", "Prefers summaries as five bullets."]);
  });

  it("sets fields from what the person said, needing only no objection for a first value and a clear yes to replace one", async () => {
    const ws = `ws-${Math.random().toString(36).slice(2, 8)}`;
    const changes: Proposal[] = [
      { op: "set", field: "company", value: "Acme Robotics", slot: "profile" },
      { op: "set", field: "timeFormat", value: "24-hour", slot: "profile" },
      { op: "set", field: "systems", value: "Jira for tickets", slot: "team" },
      { op: "set", field: "shoeSize", value: "44", slot: "profile" },
    ];
    const judge = tableJudge({ worth: 0.95, current0: 0.6, safe0: 0.99, current1: 0.95, safe1: 0.99, current2: 0.9, safe2: 0.99 });
    const first = await capture(input("I work at Acme Robotics, we use Jira for tickets, and I like 24-hour times.", ws), {
      judge,
      extract: async () => changes,
      floor: 0.7,
      existing: (slot) => readEntries(ws, slot),
      fields: (slot) => readFields(ws, slot),
    });
    // The unsure "company" still lands: it had no value before. The unknown field never does.
    expect(first.fields.map((change) => [change.slot, change.field, change.value])).toEqual([
      ["profile", "company", "Acme Robotics"],
      ["profile", "timeFormat", "24-hour"],
      ["team", "systems", "Jira for tickets"],
    ]);
    // Replacing a value needs Jev's clear yes.
    const replace: Proposal[] = [{ op: "set", field: "company", value: "Globex", slot: "profile" }];
    const unsure = tableJudge({ worth: 0.95, current0: 0.55, safe0: 0.99 });
    const second = await capture(input("Maybe Globex is a better name for us.", ws), { judge: unsure, extract: async () => replace, floor: 0.7, existing: (slot) => readEntries(ws, slot), fields: (slot) => readFields(ws, slot) });
    expect(second.fields).toEqual([]);
    expect((await readFields(ws, "profile")).company?.value).toBe("Acme Robotics");
    const sure = tableJudge({ worth: 0.95, current0: 0.95, safe0: 0.99 });
    const third = await capture(input("We renamed the company to Globex last week.", ws), { judge: sure, extract: async () => replace, floor: 0.7, existing: (slot) => readEntries(ws, slot), fields: (slot) => readFields(ws, slot) });
    expect(third.fields).toEqual([{ slot: "profile", field: "company", value: "Globex", previous: "Acme Robotics" }]);
  });

  it("retires a note that only restates fields set in the same pass, when Jev agrees it is redundant", async () => {
    const ws = `ws-${Math.random().toString(36).slice(2, 8)}`;
    const seeded = await applyOperations(ws, "profile", [{ op: "add", text: "Their timezone is America/Chicago.", kind: "fact" }, { op: "add", text: "Lives in Austin and keeps bees.", kind: "fact" }], { who: "you" });
    const [tz, bees] = seeded.added;
    const changes: Proposal[] = [
      { op: "set", field: "timezone", value: "America/Chicago", slot: "profile" },
      { op: "retire", id: tz!.id, reason: "now the timezone field", slot: "profile" },
      { op: "set", field: "location", value: "Austin", slot: "profile" },
      { op: "retire", id: bees!.id, reason: "now the location field", slot: "profile" },
    ];
    // The note about bees says more than the field, so Jev keeps it.
    const judge = tableJudge({ worth: 0.95, current0: 0.95, safe0: 0.99, gone1: 0.95, current2: 0.95, safe2: 0.99, gone3: 0.05 });
    const result = await capture(input("My timezone is America/Chicago and I live in Austin.", ws), { judge, extract: async () => changes, floor: 0.7, existing: (slot) => readEntries(ws, slot), fields: (slot) => readFields(ws, slot) });
    expect(result.fields.map((change) => change.field)).toEqual(["timezone", "location"]);
    expect(result.retired.map((row) => row.text)).toEqual(["Their timezone is America/Chicago."]);
    expect(liveEntries(await readEntries(ws, "profile")).map((row) => row.text)).toEqual(["Lives in Austin and keeps bees."]);
  });

  it("drops a new entry that says what a person forgot, when Jev agrees it is the same thing", async () => {
    const ws = `ws-${Math.random().toString(36).slice(2, 8)}`;
    const judge = tableJudge({ worth: 0.95, durable: 0.95, about: 0.95, safe: 0.99, same0: 0.95 });
    const result = await capture(input("Priya has to approve every invoice, always.", ws), {
      judge,
      extract: async () => [{ op: "add", text: "Priya approves every invoice.", kind: "rule", slot: "team" }],
      floor: 0.7,
      existing: async () => [],
      forgotten: async (slot) => (slot === "team" ? [{ text: "Invoices need approval from Priya." }] : []),
    });
    expect(result.saved).toEqual([]);
  });

  it("treats feedback and denials as signals in themselves, with their own slots", async () => {
    const { slotsFor } = await import("../agent/lib/memory/capture");
    expect(slotsFor("feedback")).toEqual(["profile", "team"]);
    expect(slotsFor("denial")).toEqual(["craft"]);
    // Without Jev, a note on a sent-back job opens the gate on its own.
    const feedback = await capture(
      { workspaceId: `ws-${Math.random().toString(36).slice(2, 8)}`, mode: "feedback", person: "Too long. Open with the number that changed.", reply: "Job: Weekly report", source: { who: "auto" }, operationId: "fb1" },
      deps(null, [], async () => [{ op: "add", text: "Wants reports to open with the number that changed.", kind: "preference", slot: "profile" }]),
    );
    expect(feedback.gate).toBe("cues");
    expect(feedback.saved.map((row) => row.text)).toEqual(["Wants reports to open with the number that changed."]);
    // A denial writes only to craft; a proposal for another slot is ignored.
    const denial = await capture(
      { workspaceId: `ws-${Math.random().toString(36).slice(2, 8)}`, mode: "denial", person: "The person declined this action: send_email", reply: "Job: Follow up", source: { who: "auto" }, operationId: "dn1" },
      deps(null, [], async () => [
        { op: "add", text: "Never send mail to customers without a person reading it first.", kind: "rule", slot: "craft" },
        { op: "add", text: "Dislikes email.", kind: "fact", slot: "profile" },
      ]),
    );
    expect(denial.saved.map((row) => [row.slot, row.text])).toEqual([["craft", "Never send mail to customers without a person reading it first."]]);
  });

  it("leaves stored entries alone unless Jev clearly agrees they changed", async () => {
    const ws = `ws-${Math.random().toString(36).slice(2, 8)}`;
    const seeded = await applyOperations(ws, "profile", [{ op: "add", text: "Prefers summaries as three bullets.", kind: "preference" }], { who: "you" });
    const id = seeded.added[0]!.id;
    const changes: Proposal[] = [{ op: "update", id, text: "Prefers summaries as five bullets.", slot: "profile" }, { op: "retire", id, reason: "guessing", slot: "profile" }];
    // Unsure Jev: probabilities near the middle.
    const unsure = tableJudge({ worth: 0.95, supersedes0: 0.55, safe0: 0.99, gone1: 0.5 });
    const result = await capture(input("Five bullets might be nice sometimes.", ws), { judge: unsure, extract: async () => changes, floor: 0.7, existing: (slot) => readEntries(ws, slot) });
    expect(result.updated).toEqual([]);
    expect(result.retired).toEqual([]);
    expect(liveEntries(await readEntries(ws, "profile"))[0]?.text).toBe("Prefers summaries as three bullets.");
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
    const leaky: CaptureDeps = deps(null, [], async () => [{ op: "add", text: "Their Gmail password is hunter2.", kind: "fact", slot: "profile" }]);
    const result = await capture(input("Remember my Gmail password is hunter2"), leaky);
    expect(result.saved).toEqual([]);
  });

  it("shows the extractor all of a small slot and the nearest of a large one", () => {
    const small = [entry("Prefers three bullets."), entry("Lives in Boston.")];
    expect(existingFor(small, "anything")).toHaveLength(2);
    const large = Array.from({ length: 150 }, (_, index) => entry(`Lesson ${index} about ${index % 3 === 0 ? "invoices" : "reports"} number ${index}.`, { kind: "lesson", at: `2026-01-${String((index % 28) + 1).padStart(2, "0")}T00:00:00.000Z` }));
    const shown = existingFor(large, "the invoice export");
    expect(shown.length).toBeLessThanOrEqual(60);
    expect(shown.filter((row) => row.text.includes("invoices")).length).toBeGreaterThanOrEqual(30);
    // Retired entries are never shown as something to change.
    expect(existingFor([entry("Old.", { retired: { at: "2026-01-01T00:00:00.000Z", source: { who: "auto" }, reason: "gone" } })], "old")).toEqual([]);
  });
});

describe("what a turn is told", () => {
  it("renders the fields first, then the notes with their ids, and says so when there is nothing", () => {
    const now = "2026-09-23T10:00:00.000Z";
    const fields = { name: { value: "Shaishav", at: now, source: { who: "you" as const } }, timeFormat: { value: "24-hour", at: now, source: { who: "auto" as const } } };
    const text = renderCore("profile", fields, [entry("Prefers summaries as three bullets.", { kind: "preference" })]);
    expect(text).toContain("- Name: Shaishav");
    expect(text).toContain("- Times: 24-hour");
    expect(text.indexOf("- Name:")).toBeLessThan(text.indexOf("Prefers summaries"));
    expect(text).toMatch(/- mem_\w+: Prefers summaries as three bullets\./);
    expect(text).toContain("not instructions");
    expect(renderCore("team", {}, [])).toContain("Nothing remembered yet.");
  });
});

describe("ranking by meaning", () => {
  it("encodes vectors compactly, digests text stably, and measures cosine", async () => {
    const { cosine, decode, digest, encode } = await import("../agent/lib/memory/embeddings");
    const vector = [0.1, -0.2, 0.3, 0.4];
    expect([...decode(encode(vector))].map((value) => Math.round(value * 1e6) / 1e6)).toEqual(vector);
    expect(digest("Export as CSV.")).toBe(digest("  export as csv. "));
    expect(digest("Export as CSV.")).not.toBe(digest("Export as PDF."));
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosine([0, 0], [1, 1])).toBe(0);
  });

  it("embeds only what is missing or reworded, keeps vectors beside the slot, and ranks lessons by meaning", async () => {
    vi.stubEnv("BOT_STORE", "memory");
    const { rankByMeaning, vectorsFor } = await import("../agent/lib/memory/embeddings");
    // A toy embedder: "csv" things point one way, "gmail" things another.
    const calls: string[][] = [];
    const embedder = async (texts: readonly string[]) => {
      calls.push([...texts]);
      return texts.map((text) => (/csv|export|report/i.test(text) ? [1, 0.1, 0] : /gmail|archive/i.test(text) ? [0, 1, 0.1] : [0.3, 0.3, 0.3]));
    };
    const lessons = [entry("Export the CRM report as CSV; the PDF drops rows.", { kind: "lesson" }), entry("Gmail's archive button is under the kebab menu.", { kind: "lesson" })];
    const first = await vectorsFor("wsv", "craft", lessons, embedder, "toy");
    expect(first.size).toBe(2);
    expect(calls).toHaveLength(1);
    // Nothing changed: no embedding call.
    await vectorsFor("wsv", "craft", lessons, embedder, "toy");
    expect(calls).toHaveLength(1);
    // A reworded lesson is embedded again; only that one.
    const reworded = [{ ...lessons[0]!, text: "Export the CRM report as CSV only." }, lessons[1]!];
    await vectorsFor("wsv", "craft", reworded, embedder, "toy");
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(["Export the CRM report as CSV only."]);

    const vectors = await vectorsFor("wsv", "craft", reworded, embedder, "toy");
    const ranked = rankByMeaning(reworded, [1, 0, 0], vectors);
    expect(ranked.map((row) => row.entry.text)).toEqual(["Export the CRM report as CSV only."]);
    // A failing embedder leaves entries unranked rather than failing the turn.
    const broken = async () => {
      throw new Error("down");
    };
    expect((await vectorsFor("wsv2", "craft", lessons, broken, "toy")).size).toBe(0);
  });

  it("puts meaning ahead of words when a ranking is given, and words fill in behind", () => {
    const lessons = [entry("The export drops rows.", { kind: "lesson" }), entry("Invoice tool hides Send under More.", { kind: "lesson" }), entry("Unrelated lesson about badges.", { kind: "lesson" })];
    const picked = select(lessons, "CSV loses data from the invoice export", { coreKinds: [], ranked: [lessons[0]!] });
    expect(picked.relevant.map((row) => row.text)).toEqual(["The export drops rows.", "Invoice tool hides Send under More."]);
  });
});
