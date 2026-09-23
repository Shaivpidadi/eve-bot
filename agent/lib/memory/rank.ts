import { confidenceOf, type MemoryEntry } from "./store";

/**
 * Which memories to bring into a turn.
 *
 * A slot can hold hundreds of entries; a turn should see a few. Two groups go
 * in: the core, which is every pinned entry and the identity facts, and the
 * entries most relevant to what was just said, ranked by shared words with the
 * common ones weighted down. No embeddings: the store is small and the words a
 * person uses for a preference are the words they use when it matters.
 */

const STOP = new Set(
  "a an and are as at be but by for from has have he her his i if in into is it its me my of on or our she so that the their them they this to us was we were what when which who will with you your".split(
    " ",
  ),
);

/** Plain plurals fold into their singular, so "invoices" finds "invoice"; addresses are left whole. */
const singular = (word: string) => (word.length > 4 && /[^suiy@]s$/.test(word) && !word.includes("@") ? word.slice(0, -1) : word);

export function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}@.]+/u)
    .map((word) => word.replace(/^[.]+|[.]+$/g, ""))
    .filter((word) => word.length > 2 && !STOP.has(word))
    .map(singular);
}

/** How rare each word is across the slot, so "invoice" counts for more than "always". */
function rarity(entries: readonly MemoryEntry[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of entries) for (const word of new Set(tokens(entry.text))) counts.set(word, (counts.get(word) ?? 0) + 1);
  const total = Math.max(1, entries.length);
  const weights = new Map<string, number>();
  for (const [word, count] of counts) weights.set(word, Math.log(1 + total / count));
  return weights;
}

/** Shared rare words, scaled by how sure the team is of the entry: a doubtful match ranks below a sure one. */
export function score(entry: MemoryEntry, query: ReadonlySet<string>, weights: ReadonlyMap<string, number>): number {
  const own = new Set(tokens(entry.text));
  if (own.size === 0) return 0;
  let sum = 0;
  for (const word of own) if (query.has(word)) sum += weights.get(word) ?? 1;
  return (sum / Math.sqrt(own.size)) * (0.5 + confidenceOf(entry) / 2);
}

export interface Selection {
  readonly core: readonly MemoryEntry[];
  readonly relevant: readonly MemoryEntry[];
}

/**
 * The entries for one turn.
 *
 * A preference about formats shares no words with "draft a note to the
 * board", yet it is exactly what that request needs. So the core is not
 * ranked: every pinned entry and every entry of a core kind goes in, newest
 * first, until the budget is spent. Only what is left over, and any kind
 * outside the core (a Bot's lessons, which grow by the hundred), is ranked by
 * shared words with the query. With no query, the most recent stand in.
 */
export function select(
  entries: readonly MemoryEntry[],
  query: string,
  options: {
    readonly maxChars?: number;
    readonly coreKinds?: readonly MemoryEntry["kind"][];
    readonly relevantMax?: number;
    /** The non-core entries already ranked by meaning (best first); word overlap ranks whatever it leaves out. */
    readonly ranked?: readonly MemoryEntry[];
  } = {},
): Selection {
  const maxChars = options.maxChars ?? 3_500;
  const coreKinds = options.coreKinds ?? ["preference", "rule", "fact"];
  const relevantMax = options.relevantMax ?? 8;
  const byRecency = (left: MemoryEntry, right: MemoryEntry) => right.at.localeCompare(left.at);
  const cost = (entry: MemoryEntry) => entry.text.length + 3;

  const core: MemoryEntry[] = [];
  let spent = 0;
  // Pinned first, then the surer, then the newer: when the budget bites, doubt goes before age.
  const bySureness = (left: MemoryEntry, right: MemoryEntry) => Math.round(confidenceOf(right) * 5) - Math.round(confidenceOf(left) * 5);
  for (const entry of [...entries]
    .filter((entry) => entry.pinned || coreKinds.includes(entry.kind))
    .sort((left, right) => Number(right.pinned) - Number(left.pinned) || bySureness(left, right) || byRecency(left, right))) {
    if (spent + cost(entry) > maxChars * 0.8) continue;
    core.push(entry);
    spent += cost(entry);
  }
  const inCore = new Set(core.map((entry) => entry.id));
  const rest = entries.filter((entry) => !inCore.has(entry.id));

  const words = new Set(tokens(query));
  const weights = rarity(entries);
  const byWords =
    words.size === 0
      ? [...rest].sort(byRecency)
      : rest
          .map((entry) => ({ entry, score: score(entry, words, weights) }))
          .filter((row) => row.score > 0)
          .sort((left, right) => right.score - left.score || byRecency(left.entry, right.entry))
          .map((row) => row.entry);
  // Meaning first when it is known; words fill in behind it for entries meaning did not reach.
  const known = new Set((options.ranked ?? []).map((entry) => entry.id));
  const ranked = [...(options.ranked ?? []).filter((entry) => !inCore.has(entry.id)), ...byWords.filter((entry) => !known.has(entry.id))];

  const relevant: MemoryEntry[] = [];
  for (const entry of ranked) {
    if (relevant.length >= relevantMax) break;
    if (spent + cost(entry) > maxChars) continue;
    relevant.push(entry);
    spent += cost(entry);
  }
  return { core, relevant };
}

/** The entries closest in wording to a candidate, for the duplicate check. */
export function nearest(entries: readonly MemoryEntry[], text: string, limit = 3): readonly MemoryEntry[] {
  const words = new Set(tokens(text));
  if (words.size === 0) return [];
  const weights = rarity(entries);
  return entries
    .map((entry) => ({ entry, score: score(entry, words, weights) }))
    .filter((row) => row.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map((row) => row.entry);
}
