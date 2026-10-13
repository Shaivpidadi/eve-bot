import type { JobLease } from "./types";

/**
 * A run's diary, kept on the job.
 *
 * eve's Workflow journal holds the model's messages, and it is bound to the
 * world and the deployment that ran them. This is the other half of a
 * session log: the facts a run produced, written into the job record under
 * the run fence, so a fresh run on any machine can pick up where the last
 * one got to instead of starting from the brief. Each entry is one line for
 * a person and, when it helps, a little data for the next run.
 */
export type JournalKind = "progress" | "decision" | "page" | "file" | "artifact" | "asked" | "handover" | "error";

export interface JournalEntry {
  readonly at: string;
  /** The lease token of the run that wrote it. */
  readonly runToken: string;
  readonly kind: JournalKind;
  /** One line, in the operator's words. */
  readonly text: string;
  /** For the next run: a page's `url`, a file's `path`, an artifact's `id`, a question's `requestId`. */
  readonly data?: Readonly<Record<string, string | number | boolean | null>>;
}

/** The first entries are kept whole (how the job began), the rest roll. */
export const KEEP_HEAD = 20;
export const KEEP_TAIL = 180;
export const MAX_ENTRIES = KEEP_HEAD + KEEP_TAIL;
/** A tool loop cannot flood the record: errors past this many in one run are dropped. */
export const MAX_ERRORS_PER_RUN = 20;

export type NewEntry = Omit<JournalEntry, "at" | "runToken"> & { readonly at?: string };

/** Older jobs have no journal; readers see an empty one. */
export const journalOf = (job: { readonly journal?: readonly JournalEntry[] }): readonly JournalEntry[] => job.journal ?? [];

/**
 * The journal with `entry` appended for `run`, or `null` when nothing should be
 * written: the same entry is already there (a replayed step, or a write that
 * landed and came back as a conflict), or the run has used up its errors.
 */
export function appended(journal: readonly JournalEntry[], run: Pick<JobLease, "token">, entry: NewEntry): JournalEntry[] | null {
  const at = entry.at ?? new Date().toISOString();
  const next: JournalEntry = { at, runToken: run.token, kind: entry.kind, text: entry.text, ...(entry.data === undefined ? {} : { data: entry.data }) };
  if (journal.some((existing) => sameEntry(existing, next))) return null;
  if (next.kind === "error" && journal.filter((existing) => existing.kind === "error" && existing.runToken === run.token).length >= MAX_ERRORS_PER_RUN) {
    return null;
  }
  return capped([...journal, next]);
}

/** The same step written twice: same run, same kind, same words, and the same data if any. */
export function sameEntry(left: JournalEntry, right: JournalEntry): boolean {
  if (left.runToken !== right.runToken || left.kind !== right.kind || left.text !== right.text) return false;
  return JSON.stringify(left.data ?? null) === JSON.stringify(right.data ?? null);
}

/**
 * Keeps the first `KEEP_HEAD` and the last `KEEP_TAIL`, folding what falls
 * between into one `progress` line so the gap stays visible.
 */
export function capped(journal: readonly JournalEntry[]): JournalEntry[] {
  if (journal.length <= MAX_ENTRIES) return [...journal];
  const head = journal.slice(0, KEEP_HEAD);
  const tail = journal.slice(-KEEP_TAIL);
  const dropped = journal.slice(KEEP_HEAD, journal.length - KEEP_TAIL);
  // A fold on top of a fold grows the count instead of stacking markers.
  const earlier = dropped.find(isFold);
  const folded = dropped.length - (earlier === undefined ? 0 : 1) + (earlier === undefined ? 0 : Number(earlier.data?.folded ?? 0));
  const marker: JournalEntry = {
    at: tail[0]?.at ?? new Date().toISOString(),
    runToken: head[head.length - 1]?.runToken ?? "",
    kind: "progress",
    text: `${folded} earlier steps folded`,
    data: { folded },
  };
  return [...head, marker, ...tail];
}

const isFold = (entry: JournalEntry): boolean => entry.kind === "progress" && entry.text.endsWith("earlier steps folded") && typeof entry.data?.folded === "number";

/** The last page a run had open, if the journal says. */
export function lastPage(journal: readonly JournalEntry[]): { readonly url: string; readonly title: string | null } | null {
  for (let index = journal.length - 1; index >= 0; index -= 1) {
    const entry = journal[index];
    if (entry?.kind === "page" && typeof entry.data?.url === "string") {
      return { url: entry.data.url, title: typeof entry.data.title === "string" ? entry.data.title : null };
    }
  }
  return null;
}

/** Files the journal says were written, each once, latest last. */
export function filesWritten(journal: readonly JournalEntry[]): string[] {
  const seen = new Set<string>();
  for (const entry of journal) {
    if (entry.kind === "file" && typeof entry.data?.path === "string") {
      seen.delete(entry.data.path);
      seen.add(entry.data.path);
    }
  }
  return [...seen];
}

/** How many of the latest lines the brief replays. */
export const REPLAY_LINES = 30;

/**
 * "Where the last run got to", for the next run's brief: why the earlier runs
 * chose what they did, the latest steps one line each, the page left open,
 * the files written, and what a person was asked and said. Empty for a
 * journal with nothing in it.
 */
export function renderJournal(journal: readonly JournalEntry[], options: { readonly limit?: number } = {}): string {
  if (journal.length === 0) return "";
  const limit = options.limit ?? REPLAY_LINES;
  const decisions = journal.filter((entry) => entry.kind === "decision").slice(-8);
  const recent = journal.slice(-limit);
  const skipped = journal.length - recent.length;
  const page = lastPage(journal);
  const files = filesWritten(journal);
  const asked = journal.filter((entry) => entry.kind === "asked" || entry.kind === "handover").slice(-4);

  const lines = [
    "## Where the last run got to",
    `An earlier run of this job stopped before it finished. This is what it recorded (${journal.length} steps). Continue from here: do not redo a step listed below unless the page or file shows it did not land.`,
  ];
  if (decisions.length > 0) lines.push("", "Decisions so far:", ...decisions.map((entry) => `- ${entry.text}`));
  lines.push("", skipped > 0 ? `Last ${recent.length} steps (${skipped} earlier ones not shown):` : "Steps:");
  recent.forEach((entry, index) => lines.push(`${skipped + index + 1}. [${entry.kind}] ${entry.text}`));
  if (page !== null) lines.push("", `Open page: ${page.url}`);
  if (files.length > 0) lines.push("", `Files written: ${files.slice(-12).join(", ")}`);
  if (asked.length > 0) lines.push("", "Asked and answered:", ...asked.map((entry) => `- ${entry.text}`));
  return lines.join("\n");
}
