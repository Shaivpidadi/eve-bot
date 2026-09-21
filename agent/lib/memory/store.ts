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
}

export interface MemoryDoc {
  readonly entries: readonly MemoryEntry[];
  /** Operation ids already captured, so a replayed capture writes nothing twice. */
  readonly seen: readonly string[];
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
const SEEN_KEPT = 64;

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
    /\b(?:\d[ -]?){13,19}\b/.test(text) ||
    /\b(sk|pk|ghp|gho|xox[abp]|vck|AKIA)[-_a-zA-Z0-9]{8,}/.test(text) ||
    /\beyJ[a-zA-Z0-9_-]{10,}\./.test(text)
  );
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
  const at = (options.now ?? new Date()).toISOString();
  let outcome: RememberOutcome = { added: [], duplicates: 0, refused: 0, replayed: false };
  await updateDoc<MemoryDoc>(key(workspaceId, slot), (current) => {
    const doc = current ?? EMPTY;
    if (options.operationId !== undefined && doc.seen.includes(options.operationId)) {
      outcome = { added: [], duplicates: 0, refused: 0, replayed: true };
      return null;
    }
    const known = new Set(doc.entries.map((entry) => comparable(entry.text)));
    const added: MemoryEntry[] = [];
    let duplicates = 0;
    let refused = 0;
    for (const candidate of candidates) {
      const checked = acceptable(candidate);
      if (!checked.ok) continue;
      const seenAs = comparable(checked.text);
      if (known.has(seenAs)) {
        duplicates += 1;
        continue;
      }
      if (doc.entries.length + added.length >= SLOTS[slot].maxEntries) {
        refused += 1;
        continue;
      }
      known.add(seenAs);
      added.push({
        id: newId("mem"),
        text: checked.text,
        kind: candidate.kind,
        source,
        at,
        pinned: options.pinned ?? false,
        recalls: 0,
        lastRecalledAt: null,
      });
    }
    outcome = { added, duplicates, refused, replayed: false };
    const seen = options.operationId === undefined ? doc.seen : [...doc.seen, options.operationId].slice(-SEEN_KEPT);
    if (added.length === 0 && seen === doc.seen) return null;
    return { entries: [...doc.entries, ...added], seen, updatedAt: at };
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

export function forget(workspaceId: string, slot: MemorySlot, id: string): Promise<EditOutcome> {
  return editEntry(workspaceId, slot, id, () => null);
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
