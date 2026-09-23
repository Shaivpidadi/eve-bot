import { newId } from "../ids";
import { readDoc, store, updateDoc } from "../store";

/**
 * What the team remembers, as records.
 *
 * One document per workspace and slot. A workspace usually belongs to one
 * person, so every slot is the workspace's: `profile` is about that person,
 * `team` about how the team works, `craft` what the Bots have learned doing the
 * work. Each entry carries who saved it and from where, so the console can show
 * where a memory came from and a person can forget it in one click.
 *
 * Documents are written with the store's compare-and-set, so two saves in one
 * step both land. Entries are capped per slot; the model's recall is capped
 * separately by characters (see `rank.ts`), so a full slot costs nothing extra
 * per turn.
 */

export type MemorySlot = "profile" | "team" | "craft";
export type MemoryKind = "preference" | "fact" | "rule" | "lesson";

/** Who put a memory there: the coordinator, a Bot by name, the person, or automatic capture. */
export interface MemorySource {
  readonly who: "hq" | "bot" | "you" | "auto" | "import";
  readonly name?: string;
  readonly room?: string | null;
  readonly jobId?: string | null;
}

/** An earlier wording this entry replaced, kept so memory correcting itself stays visible. */
export interface MemoryRevision {
  readonly text: string;
  readonly at: string;
  readonly source: MemorySource;
}

export interface MemoryEntry {
  readonly id: string;
  readonly text: string;
  readonly kind: MemoryKind;
  readonly source: MemorySource;
  readonly at: string;
  /** Pinned entries are recalled on every turn regardless of relevance. */
  readonly pinned: boolean;
  readonly recalls: number;
  readonly lastRecalledAt: string | null;
  /**
   * How sure the team is of this entry, 0 to 1. A person's own words score
   * highest; a capture scores what Jev thought of it. Rises when the person
   * says the same thing again. Absent on older entries, read as 0.7.
   */
  readonly confidence?: number;
  /** When the person last said something that confirmed this entry. */
  readonly lastConfirmedAt?: string | null;
  /** What this entry used to say, newest first. Absent when it was never changed. */
  readonly history?: readonly MemoryRevision[];
  /** Set when the entry was found to be no longer true. Retired entries are kept, shown, and not recalled. */
  readonly retired?: { readonly at: string; readonly source: MemorySource; readonly reason: string } | null;
}

/** One change to a slot, as the extractor proposes it and the store applies it. */
export type MemoryOperation =
  | { readonly op: "add"; readonly text: string; readonly kind: MemoryKind; readonly confidence?: number }
  | { readonly op: "update"; readonly id: string; readonly text: string; readonly kind?: MemoryKind; readonly confidence?: number }
  | { readonly op: "retire"; readonly id: string; readonly reason: string }
  /** Sets a field of the typed core; an empty value clears it. */
  | { readonly op: "set"; readonly field: string; readonly value: string }
  /** The person said an existing memory again; it grows surer. */
  | { readonly op: "confirm"; readonly id: string };

export interface FieldChange {
  readonly field: string;
  readonly value: string;
  readonly previous: string | null;
}

export interface ApplyOutcome {
  readonly added: readonly MemoryEntry[];
  readonly updated: readonly MemoryEntry[];
  readonly retired: readonly MemoryEntry[];
  readonly fields: readonly FieldChange[];
  /** Ids the person restated, now surer. */
  readonly confirmed: readonly string[];
  readonly duplicates: number;
  readonly refused: number;
  readonly replayed: boolean;
}

/**
 * The typed core: facts that are fields, not prose. A field has one current
 * value, so a changed preference is an overwrite rather than a second
 * sentence, and recall renders the lot as one compact block that always fits.
 */
export interface MemoryField {
  readonly key: string;
  readonly label: string;
  /** What belongs here, for the extractor and the page. */
  readonly hint: string;
}

export const FIELDS: Readonly<Record<MemorySlot, readonly MemoryField[]>> = {
  profile: [
    { key: "name", label: "Name", hint: "What to call them" },
    { key: "company", label: "Company", hint: "Who they work for" },
    { key: "role", label: "Role", hint: "Their job or title" },
    { key: "location", label: "Location", hint: "City or region they work from" },
    { key: "timezone", label: "Timezone", hint: "IANA name, such as America/New_York" },
    { key: "language", label: "Language", hint: "The language to write in" },
    { key: "spelling", label: "Spelling", hint: "British, American, or another convention" },
    { key: "dateFormat", label: "Dates", hint: "How dates are written, by example: 21 Sep 2026" },
    { key: "timeFormat", label: "Times", hint: "12-hour or 24-hour" },
    { key: "tone", label: "Tone", hint: "How drafts should sound: formal, warm, terse" },
    { key: "length", label: "Length", hint: "How long answers and results should run" },
  ],
  team: [
    { key: "approvals", label: "Approvals", hint: "Who signs off on what" },
    { key: "cc", label: "Always cc", hint: "Who is copied on which mail" },
    { key: "systems", label: "Systems of record", hint: "Where tickets, docs, customers and code live" },
    { key: "schedule", label: "Schedule", hint: "Recurring reports and meetings and when they go out" },
    { key: "style", label: "House style", hint: "How anything the team publishes should read" },
    { key: "escalation", label: "Escalation", hint: "Who to bring in when something goes wrong" },
  ],
  craft: [],
};

export const fieldFor = (slot: MemorySlot, key: string): MemoryField | undefined => FIELDS[slot].find((field) => field.key === key);

/** A field named loosely, as a model tends to: "Time format", "time_format", "Times" and "timeFormat" all resolve. */
export function resolveField(slot: MemorySlot, name: string): MemoryField | undefined {
  const loose = name.toLowerCase().replace(/[^a-z]/g, "");
  if (loose === "") return undefined;
  return FIELDS[slot].find((field) => field.key.toLowerCase() === loose || field.label.toLowerCase().replace(/[^a-z]/g, "") === loose);
}

export interface MemoryFieldValue {
  readonly value: string;
  readonly at: string;
  readonly source: MemorySource;
  /** Earlier values, newest first. */
  readonly history?: readonly { readonly value: string; readonly at: string; readonly source: MemorySource }[];
}

export interface MemoryDoc {
  readonly entries: readonly MemoryEntry[];
  /** The typed core, by field key. Absent on documents from before fields existed. */
  readonly fields?: Readonly<Record<string, MemoryFieldValue>>;
  /** Operation ids already captured, so a replayed capture writes nothing twice. */
  readonly seen: readonly string[];
  /** What a person forgot by hand, so capture does not put it straight back. */
  readonly forgotten?: readonly { readonly text: string; readonly at: string }[];
  readonly updatedAt: string;
}

export interface MemoryCandidate {
  readonly text: string;
  readonly kind: MemoryKind;
}

export const SLOTS = {
  profile: {
    label: "About you",
    detail: "Who you are and how you like things done. Recalled by HQ and by every Bot.",
    maxEntries: 200,
  },
  team: {
    label: "Your team",
    detail: "How this workspace works: who approves what, which systems are the source of truth, house style.",
    maxEntries: 200,
  },
  craft: {
    label: "How to do your work",
    detail: "What the Bots have learned doing jobs here: the quirks of your systems and what a finished deliverable looks like.",
    maxEntries: 300,
  },
} as const satisfies Record<MemorySlot, { readonly label: string; readonly detail: string; readonly maxEntries: number }>;

export const MEMORY_SLOTS = Object.keys(SLOTS) as readonly MemorySlot[];
export const isMemorySlot = (value: string): value is MemorySlot => Object.hasOwn(SLOTS, value);
export const isMemoryKind = (value: unknown): value is MemoryKind =>
  value === "preference" || value === "fact" || value === "rule" || value === "lesson";

const MAX_TEXT_CHARS = 500;

/** How sure to be of an entry by who put it there, when nothing better is known. */
const DEFAULT_CONFIDENCE: Readonly<Record<MemorySource["who"], number>> = { you: 1, hq: 0.85, bot: 0.8, auto: 0.7, import: 0.75 };
export const confidenceOf = (entry: Pick<MemoryEntry, "confidence" | "source">): number => entry.confidence ?? DEFAULT_CONFIDENCE[entry.source.who];
const clamp = (value: number) => Math.min(1, Math.max(0.05, Math.round(value * 100) / 100));

/** Entries not recalled for this long fade: kept, shown, and left out of recall until a person brings them back. */
export const FADE_AFTER_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_FIELD_CHARS = 200;
const SEEN_KEPT = 64;
const FORGOTTEN_KEPT = 100;

const key = (workspaceId: string, slot: MemorySlot) => `memory/v2/${workspaceId}/${slot}.json`;
const EMPTY: MemoryDoc = { entries: [], seen: [], updatedAt: "" };

/** One line, single spaces, so the same thought written twice compares equal. */
export const normalize = (text: string): string => text.trim().replace(/\s+/g, " ");
const comparable = (text: string): string => normalize(text).toLowerCase().replace(/[.!]+$/, "");

/**
 * Things that must never be remembered, whatever the model decided: keys,
 * tokens, card numbers, anything labelled as a password or code.
 */
export function looksSecret(text: string): boolean {
  return (
    /\b(password|passcode|passwd|api[ -]?key|secret|token|otp|one[- ]time code|verification code|cvv|ssn)\b\s*[:=]?\s*\S/i.test(text) ||
    looksLikeCard(text) ||
    /\b(sk|pk|ghp|gho|xox[abp]|vck|AKIA)[-_a-zA-Z0-9]{8,}/.test(text) ||
    /\beyJ[a-zA-Z0-9_-]{10,}\./.test(text)
  );
}

/** A run of 13 to 19 digits that passes the Luhn check, which is how card numbers are made; a timestamp or an order number almost never does. */
function looksLikeCard(text: string): boolean {
  for (const match of text.matchAll(/\b(?:\d[ -]?){13,19}\b/g)) {
    const digits = match[0].replace(/\D/g, "");
    let sum = 0;
    for (let index = 0; index < digits.length; index += 1) {
      let digit = Number(digits[digits.length - 1 - index]);
      if (index % 2 === 1) digit = digit * 2 > 9 ? digit * 2 - 9 : digit * 2;
      sum += digit;
    }
    if (sum % 10 === 0) return true;
  }
  return false;
}

/** A memory the store will take: non-empty, not a secret, not absurdly long. */
export function acceptable(candidate: MemoryCandidate): { readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: string } {
  const text = normalize(candidate.text);
  if (text === "") return { ok: false, reason: "Write something to remember." };
  if (text.length > MAX_TEXT_CHARS) return { ok: false, reason: `Keep a memory under ${MAX_TEXT_CHARS} characters.` };
  if (looksSecret(text)) return { ok: false, reason: "That looks like a secret; passwords, codes and keys are never remembered." };
  return { ok: true, text };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export async function readMemoryDoc(workspaceId: string, slot: MemorySlot): Promise<MemoryDoc> {
  const doc = (await readDoc<MemoryDoc>(key(workspaceId, slot)))?.value;
  if (doc !== undefined) return doc;
  const imported = await importLegacy(workspaceId, slot);
  return imported ?? EMPTY;
}

export async function readEntries(workspaceId: string, slot: MemorySlot): Promise<readonly MemoryEntry[]> {
  return (await readMemoryDoc(workspaceId, slot)).entries;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export interface RememberOutcome {
  readonly added: readonly MemoryEntry[];
  /** Candidates that matched an entry already there, word for word. */
  readonly duplicates: number;
  /** Candidates that did not fit: the slot is full. */
  readonly refused: number;
  /** True when this operation had already been captured; nothing was written. */
  readonly replayed: boolean;
}

/**
 * Adds candidates to a slot. Word-for-word duplicates are skipped, a full slot
 * refuses the rest, and a repeated `operationId` writes nothing.
 */
export async function remember(
  workspaceId: string,
  slot: MemorySlot,
  candidates: readonly MemoryCandidate[],
  source: MemorySource,
  options: { readonly operationId?: string; readonly pinned?: boolean; readonly now?: Date } = {},
): Promise<RememberOutcome> {
  const outcome = await applyOperations(
    workspaceId,
    slot,
    candidates.map((candidate) => ({ op: "add" as const, text: candidate.text, kind: candidate.kind })),
    source,
    options,
  );
  const added = options.pinned === true && outcome.added.length > 0 ? await pinAll(workspaceId, slot, outcome.added) : outcome.added;
  return { added, duplicates: outcome.duplicates, refused: outcome.refused, replayed: outcome.replayed };
}

async function pinAll(workspaceId: string, slot: MemorySlot, entries: readonly MemoryEntry[]): Promise<readonly MemoryEntry[]> {
  const ids = new Set(entries.map((entry) => entry.id));
  await updateDoc<MemoryDoc>(key(workspaceId, slot), (current) =>
    current === null ? null : { ...current, entries: current.entries.map((entry) => (ids.has(entry.id) ? { ...entry, pinned: true } : entry)) },
  );
  return entries.map((entry) => ({ ...entry, pinned: true }));
}

/**
 * Applies a set of operations in one write: new entries, entries reworded
 * (the old wording goes into the entry's history), and entries retired as no
 * longer true. Word-for-word duplicates of a live entry are skipped; an
 * operation on an id that is gone is skipped; a repeated `operationId`
 * writes nothing.
 */
export async function applyOperations(
  workspaceId: string,
  slot: MemorySlot,
  operations: readonly MemoryOperation[],
  source: MemorySource,
  options: { readonly operationId?: string; readonly now?: Date } = {},
): Promise<ApplyOutcome> {
  const at = (options.now ?? new Date()).toISOString();
  let outcome: ApplyOutcome = { added: [], updated: [], retired: [], fields: [], confirmed: [], duplicates: 0, refused: 0, replayed: false };
  await updateDoc<MemoryDoc>(key(workspaceId, slot), (current) => {
    const doc = current ?? EMPTY;
    if (options.operationId !== undefined && doc.seen.includes(options.operationId)) {
      outcome = { ...outcome, replayed: true };
      return null;
    }
    const entries = [...doc.entries];
    const forgottenTexts = new Set((doc.forgotten ?? []).map((item) => comparable(item.text)));
    const live = () => entries.filter((entry) => !entry.retired);
    const known = () => new Set(live().map((entry) => comparable(entry.text)));
    const added: MemoryEntry[] = [];
    const updated: MemoryEntry[] = [];
    const retired: MemoryEntry[] = [];
    const fields: Record<string, MemoryFieldValue> = { ...doc.fields };
    const changed: FieldChange[] = [];
    const confirmedIds: string[] = [];
    let duplicates = 0;
    let refused = 0;

    for (const operation of operations) {
      if (operation.op === "confirm") {
        const index = entries.findIndex((entry) => entry.id === operation.id && !entry.retired);
        const before = entries[index];
        if (before === undefined) continue;
        entries[index] = { ...before, confidence: clamp(confidenceOf(before) + 0.1), lastConfirmedAt: at, lastRecalledAt: at };
        confirmedIds.push(before.id);
        continue;
      }
      if (operation.op === "set") {
        const field = resolveField(slot, operation.field);
        if (field === undefined) continue;
        const value = normalize(operation.value).slice(0, MAX_FIELD_CHARS);
        const before = fields[field.key];
        if ((before?.value ?? "") === value) continue;
        if (value !== "" && looksSecret(value)) continue;
        if (value === "") delete fields[field.key];
        else {
          fields[field.key] = {
            value,
            at,
            source,
            history: before === undefined ? [] : [{ value: before.value, at: before.at, source: before.source }, ...(before.history ?? [])].slice(0, 10),
          };
        }
        changed.push({ field: field.key, value, previous: before?.value ?? null });
        continue;
      }
      if (operation.op === "add") {
        const checked = acceptable(operation);
        if (!checked.ok) continue;
        if (known().has(comparable(checked.text)) || forgottenTexts.has(comparable(checked.text))) {
          duplicates += 1;
          continue;
        }
        if (live().length >= SLOTS[slot].maxEntries) {
          refused += 1;
          continue;
        }
        const entry: MemoryEntry = {
          id: newId("mem"),
          text: checked.text,
          kind: operation.kind,
          source,
          at,
          pinned: false,
          recalls: 0,
          lastRecalledAt: null,
          confidence: clamp(operation.confidence ?? DEFAULT_CONFIDENCE[source.who]),
        };
        entries.push(entry);
        added.push(entry);
        continue;
      }
      const index = entries.findIndex((entry) => entry.id === operation.id && !entry.retired);
      const before = entries[index];
      if (before === undefined) continue;
      if (operation.op === "update") {
        const checked = acceptable({ text: operation.text, kind: operation.kind ?? before.kind });
        if (!checked.ok || comparable(checked.text) === comparable(before.text)) continue;
        const next: MemoryEntry = {
          ...before,
          text: checked.text,
          kind: operation.kind ?? before.kind,
          source,
          at,
          confidence: clamp(operation.confidence ?? DEFAULT_CONFIDENCE[source.who]),
          history: [{ text: before.text, at: before.at, source: before.source }, ...(before.history ?? [])].slice(0, 10),
        };
        entries[index] = next;
        updated.push(next);
      } else {
        const next: MemoryEntry = { ...before, retired: { at, source, reason: normalize(operation.reason).slice(0, 300) } };
        entries[index] = next;
        retired.push(next);
      }
    }
    outcome = { added, updated, retired, fields: changed, confirmed: confirmedIds, duplicates, refused, replayed: false };
    const seen = options.operationId === undefined ? doc.seen : [...doc.seen, options.operationId].slice(-SEEN_KEPT);
    if (added.length + updated.length + retired.length + changed.length + confirmedIds.length === 0 && seen === doc.seen) return null;
    return { ...doc, entries, fields, seen, updatedAt: at };
  });
  return outcome;
}

type EditOutcome = { readonly ok: true } | { readonly ok: false; readonly status: 400 | 404 | 409; readonly error: string };

async function editEntry(
  workspaceId: string,
  slot: MemorySlot,
  id: string,
  change: (entry: MemoryEntry, all: readonly MemoryEntry[]) => MemoryEntry | null | EditOutcome,
): Promise<EditOutcome> {
  let outcome: EditOutcome = { ok: false, status: 404, error: "No such memory." };
  await updateDoc<MemoryDoc>(key(workspaceId, slot), (current) => {
    const doc = current ?? EMPTY;
    const entry = doc.entries.find((candidate) => candidate.id === id);
    if (entry === undefined) {
      outcome = { ok: false, status: 404, error: "No such memory." };
      return null;
    }
    const next = change(entry, doc.entries);
    if (next !== null && "ok" in next) {
      outcome = next;
      return null;
    }
    outcome = { ok: true };
    return {
      ...doc,
      entries: next === null ? doc.entries.filter((candidate) => candidate.id !== id) : doc.entries.map((candidate) => (candidate.id === id ? next : candidate)),
      updatedAt: new Date().toISOString(),
    };
  });
  return outcome;
}

/** The typed core of a slot, as stored. */
export async function readFields(workspaceId: string, slot: MemorySlot): Promise<Readonly<Record<string, MemoryFieldValue>>> {
  return (await readMemoryDoc(workspaceId, slot)).fields ?? {};
}

/** Sets one field by hand; an empty value clears it. */
export async function setField(workspaceId: string, slot: MemorySlot, field: string, value: string, source: MemorySource): Promise<EditOutcome> {
  if (resolveField(slot, field) === undefined) return { ok: false, status: 404, error: "No such field." };
  if (normalize(value) !== "" && looksSecret(value)) return { ok: false, status: 400, error: "That looks like a secret; passwords, codes and keys are never remembered." };
  await applyOperations(workspaceId, slot, [{ op: "set", field, value }], source);
  return { ok: true };
}

/** Brings a retired entry back, when the person says it is still true. */
export function restore(workspaceId: string, slot: MemorySlot, id: string): Promise<EditOutcome> {
  return editEntry(workspaceId, slot, id, (entry) => ({ ...entry, retired: null, at: new Date().toISOString() }));
}

/** The entries a turn may recall: not retired. */
export const liveEntries = (entries: readonly MemoryEntry[]): readonly MemoryEntry[] => entries.filter((entry) => !entry.retired);

/** An entry nobody has needed for `FADE_AFTER_MS`: live, but left out of recall until brought back. Pinned entries never fade. */
export const isFaded = (entry: MemoryEntry, now: number = Date.now()): boolean => {
  if (entry.pinned || entry.retired) return false;
  const last = Date.parse(entry.lastRecalledAt ?? entry.lastConfirmedAt ?? entry.at);
  return Number.isFinite(last) && now - last > FADE_AFTER_MS;
};

/** What a turn is offered: live and not faded. */
export const recallable = (entries: readonly MemoryEntry[], now: number = Date.now()): readonly MemoryEntry[] => liveEntries(entries).filter((entry) => !isFaded(entry, now));

/** The person said it again: the entry is surer, and it counts as used today. */
export async function confirm(workspaceId: string, slot: MemorySlot, ids: readonly string[], now: Date = new Date()): Promise<void> {
  if (ids.length === 0) return;
  const wanted = new Set(ids);
  const at = now.toISOString();
  await updateDoc<MemoryDoc>(key(workspaceId, slot), (current) => {
    if (current === null) return null;
    return {
      ...current,
      entries: current.entries.map((entry) =>
        wanted.has(entry.id) ? { ...entry, confidence: clamp(confidenceOf(entry) + 0.1), lastConfirmedAt: at, lastRecalledAt: at } : entry,
      ),
      updatedAt: at,
    };
  });
}

/** A faded entry a person wants back in recall: it counts as used today. */
export function revive(workspaceId: string, slot: MemorySlot, id: string): Promise<EditOutcome> {
  return editEntry(workspaceId, slot, id, (entry) => ({ ...entry, lastRecalledAt: new Date().toISOString(), retired: null }));
}

/** Forgets an entry for good, and remembers that it was forgotten so capture does not put it straight back. */
export async function forget(workspaceId: string, slot: MemorySlot, id: string): Promise<EditOutcome> {
  let outcome: EditOutcome = { ok: false, status: 404, error: "No such memory." };
  await updateDoc<MemoryDoc>(key(workspaceId, slot), (current) => {
    const doc = current ?? EMPTY;
    const entry = doc.entries.find((candidate) => candidate.id === id);
    if (entry === undefined) return null;
    outcome = { ok: true };
    return {
      ...doc,
      entries: doc.entries.filter((candidate) => candidate.id !== id),
      forgotten: [{ text: entry.text, at: new Date().toISOString() }, ...(doc.forgotten ?? [])].slice(0, FORGOTTEN_KEPT),
      updatedAt: new Date().toISOString(),
    };
  });
  return outcome;
}

/** What a person forgot by hand in this slot, newest first. */
export async function readForgotten(workspaceId: string, slot: MemorySlot): Promise<readonly { readonly text: string; readonly at: string }[]> {
  return (await readMemoryDoc(workspaceId, slot)).forgotten ?? [];
}

export function pin(workspaceId: string, slot: MemorySlot, id: string, pinned: boolean): Promise<EditOutcome> {
  return editEntry(workspaceId, slot, id, (entry) => ({ ...entry, pinned }));
}

export function rewrite(workspaceId: string, slot: MemorySlot, id: string, text: string): Promise<EditOutcome> {
  return editEntry(workspaceId, slot, id, (entry, all) => {
    const checked = acceptable({ text, kind: entry.kind });
    if (!checked.ok) return { ok: false, status: 400, error: checked.reason };
    if (all.some((other) => other.id !== id && comparable(other.text) === comparable(checked.text))) {
      return { ok: false, status: 409, error: "Another memory already says that." };
    }
    return { ...entry, text: checked.text };
  });
}

/** Counts a recall, best effort: a lost count changes nothing a person sees. */
export async function noteRecalled(workspaceId: string, slot: MemorySlot, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const wanted = new Set(ids);
  const at = new Date().toISOString();
  await updateDoc<MemoryDoc>(key(workspaceId, slot), (current) => {
    if (current === null) return null;
    return {
      ...current,
      entries: current.entries.map((entry) => (wanted.has(entry.id) ? { ...entry, recalls: entry.recalls + 1, lastRecalledAt: at } : entry)),
    };
  }).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Entries written by eve's file memory, before this store existed.
// ---------------------------------------------------------------------------

const LEGACY_HEADER = /^<!-- eve-memory-file-v1 lastAllocatedIndex=(-1|0|[1-9]\d*) -->\n/;

/** Reads every legacy document for a slot in this workspace (one per person, or one shared) into the new store, once. */
async function importLegacy(workspaceId: string, slot: MemorySlot): Promise<MemoryDoc | null> {
  const index = (await readDoc<Record<string, { readonly key: string }>>(`memory/index/${workspaceId}.json`))?.value;
  if (index === undefined) return null;
  const texts: string[] = [];
  for (const [name, record] of Object.entries(index)) {
    if (name !== slot && !name.startsWith(`${slot}:`)) continue;
    const doc = await store().get(`memory/documents/${encodeURIComponent(record.key)}.md`);
    if (doc === null || !LEGACY_HEADER.test(doc.value)) continue;
    for (const line of doc.value.replace(LEGACY_HEADER, "").split("\n")) {
      const match = /^\d+: (.+)$/.exec(line);
      if (match?.[1] !== undefined) texts.push(match[1]);
    }
  }
  if (texts.length === 0) return null;
  const kind: MemoryKind = slot === "craft" ? "lesson" : slot === "team" ? "rule" : "fact";
  const outcome = await remember(workspaceId, slot, texts.map((text) => ({ text, kind })), { who: "import" }, { operationId: `legacy:${workspaceId}:${slot}` });
  return outcome.added.length === 0 ? null : (await readDoc<MemoryDoc>(key(workspaceId, slot)))?.value ?? null;
}
