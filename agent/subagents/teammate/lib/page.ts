import type { ToolContext } from "eve/tools";

import { browser, refreshScreen } from "./browser";

/**
 * What a Bot sees of a page, kept small.
 *
 * agent-browser's accessibility tree says everything about a page, which is
 * the problem: a mail inbox runs to tens of thousands of characters, most of
 * it wrappers with no name, line breaks, and container rows that repeat the
 * text of every child under them. Sent into the model after every click, that
 * is where a browser job's time and money go, and it is what loses a small
 * model. This module reads a page once, settled, and hands the Bot the part
 * that matters within a budget; after an action it says what changed, so a
 * click that did nothing is reported as exactly that.
 *
 * The trimming and the comparison are pure functions over the tree text, so
 * they are tested without a browser. Refs survive trimming untouched: a
 * trimmed tree is a subset of the lines of the snapshot it came from.
 */

const positive = (raw: string | undefined, fallback: number): number => {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

/** Characters of tree a Bot gets by default; `page_snapshot` with `full` gets agent-browser's own cap. */
export const pageBudget = (): number => positive(process.env.BOT_BROWSER_PAGE_CHARS, 8_000);
/** A moment for the page to finish re-rendering after the load event, before it is read. */
const settleMs = (): number => positive(process.env.BOT_BROWSER_SETTLE_MS, 300);

/** `  - link "Inbox" [ref=e12] [selected]`; the name and the trailing flags are optional. */
const LINE = /^(\s*)-\s+([A-Za-z]+)(?:\s+"((?:[^"\\]|\\.)*)")?(.*)$/;
const REF = /\[ref=e\d+\]/;
/** agent-browser's content-boundary markers, kept so the model sees where page text starts and ends. */
const MARKER = /^\[(?:BEGIN|END) /;

/** Wrappers that carry nothing of their own; dropped unless named or interactive. */
const STRUCTURAL = new Set([
  "generic", "group", "none", "presentation", "section", "region", "article", "main", "navigation", "banner",
  "contentinfo", "complementary", "form", "table", "row", "rowgroup", "cell", "columnheader", "rowheader",
  "gridcell", "list", "listitem", "paragraph", "LayoutTable", "LayoutTableRow", "LayoutTableCell", "Iframe",
  "iframe", "figure", "document", "WebArea", "RootWebArea",
]);
/** Text the Bot needs even when it cannot be clicked: what the page says and how it is organised. */
const TEXTUAL = new Set(["heading", "StaticText", "text", "paragraph", "alert", "status", "dialog", "alertdialog", "log", "note", "caption"]);

const NAME_CHARS = { interactive: 120, textual: 160, container: 80 } as const;

interface Line {
  readonly depth: number;
  readonly role: string;
  readonly name: string | null;
  readonly rest: string;
  readonly interactive: boolean;
  readonly raw: string;
}

function parse(raw: string): Line | null {
  const match = LINE.exec(raw);
  if (match === null) return null;
  const [, indent = "", role = "", name, rest = ""] = match;
  return { depth: Math.floor(indent.length / 2), role, name: name ?? null, rest: tidy(rest), interactive: REF.test(rest), raw };
}

/** Flags that say a thing can be clicked, which the ref already says. */
const tidy = (rest: string): string =>
  rest
    .replace(/\[(?:onclick|tabindex(?:=[^\]]*)?)\]/g, "")
    .replace(/\b(?:clickable|focusable)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function render(line: Line, nameChars: number, baseDepth: number): string {
  const name = line.name === null ? "" : ` "${clip(line.name, nameChars)}"`;
  const rest = line.rest === "" ? "" : ` ${line.rest}`;
  return `${" ".repeat(Math.min(Math.max(0, line.depth - baseDepth), 8))}- ${line.role}${name}${rest}`;
}

/** Noise with no information for a Bot: line breaks, unnamed pictures, unnamed wrappers. */
function noise(line: Line): boolean {
  if (line.interactive) return false;
  if (line.role === "LineBreak") return true;
  if ((line.role === "image" || line.role === "img") && (line.name === null || line.name.trim() === "")) return true;
  return STRUCTURAL.has(line.role) && (line.name === null || line.name.trim() === "");
}

/**
 * Containers that add nothing over what is under them:
 * - a named one whose name is the text of a named descendant, such as
 *   `cell "Acme · Invoice" [ref=e3]` over `link "Acme"` and `link "Invoice"`;
 * - an unnamed interactive one with interactive descendants, since those give
 *   the same reach with a name, or with nothing under it at all.
 * An unnamed interactive container over plain text stays: that row is the
 * only handle on what it holds.
 */
function dropEchoes(lines: Line[]): void {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!;
    if (!STRUCTURAL.has(line.role)) continue;
    const name = line.name?.trim() ?? "";
    let descendants = 0;
    let interactiveBelow = false;
    let echoed = false;
    for (let j = i + 1; j < lines.length && lines[j]!.depth > line.depth; j += 1) {
      descendants += 1;
      const child = lines[j]!;
      if (child.interactive) interactiveBelow = true;
      const childName = child.name?.trim() ?? "";
      if (name !== "" && childName !== "" && name.includes(childName)) echoed = true;
    }
    const drop = name === "" ? line.interactive && (interactiveBelow || descendants === 0) : echoed;
    if (drop) lines.splice(i, 1);
  }
}

export interface Trimmed {
  readonly text: string;
  /** Lines shown, of the lines the snapshot had after noise was removed. */
  readonly shown: number;
  readonly of: number;
  readonly interactive: number;
  /** How hard the tree had to be cut: 0 kept everything but noise, 3 hit the hard limit. */
  readonly level: 0 | 1 | 2 | 3;
}

/**
 * The tree within `budget` characters, cut in order of what a Bot can spare:
 * noise first, then unnamed and container text, then everything that is not
 * a heading or interactive, and last a hard cut with a note saying so.
 */
export function trimTree(snapshot: string, budget: number): Trimmed {
  const markers: string[] = [];
  const lines: Line[] = [];
  for (const raw of snapshot.split("\n")) {
    const text = raw.trimEnd();
    if (text.trim() === "") continue;
    if (MARKER.test(text.trim())) {
      markers.push(text.trim());
      continue;
    }
    const line = parse(text);
    if (line === null) {
      lines.push({ depth: 0, role: "", name: null, rest: text.trim(), interactive: REF.test(text), raw: text });
      continue;
    }
    if (!noise(line)) lines.push(line);
  }
  dropEchoes(lines);
  const of = lines.length;
  const interactive = lines.filter((line) => line.interactive).length;
  const wrap = (body: string[]) => [markers[0], ...body, markers[1]].filter((entry): entry is string => entry !== undefined).join("\n");
  // Nothing parsed as a tree: an error page, plain text, whatever a command
  // wrote instead. Trimming by role would drop every line and hand the bot a
  // note about lines it cannot see, so the text itself is clipped and kept.
  if (lines.length > 0 && lines.every((line) => line.role === "")) {
    const raw = lines.map((line) => line.rest).join("\n");
    const room = Math.max(200, budget - markers.join("\n").length - 2);
    return { text: wrap([clip(raw, room)]), shown: lines.length, of, interactive, level: 3 };
  }
  // Indentation is relative to the shallowest line kept, so a tree does not start eight spaces in.
  const baseDepth = lines.reduce((min, line) => Math.min(min, line.depth), Number.POSITIVE_INFINITY);
  const show = (line: Line) =>
    line.role === ""
      ? line.rest
      : render(line, line.interactive ? NAME_CHARS.interactive : TEXTUAL.has(line.role) ? NAME_CHARS.textual : NAME_CHARS.container, baseDepth);

  const attempt = (kept: Line[], level: 0 | 1 | 2): Trimmed | null => {
    const text = wrap(kept.map(show));
    return text.length <= budget ? { text, shown: kept.length, of, interactive, level } : null;
  };

  const full = attempt(lines, 0);
  if (full !== null) return full;
  const textual = attempt(lines.filter((line) => line.interactive || TEXTUAL.has(line.role)), 1);
  if (textual !== null) return textual;
  const headings = lines.filter((line) => line.interactive || line.role === "heading");
  const essential = attempt(headings, 2);
  if (essential !== null) return essential;

  // Hard cut: as many of the essential lines as fit, and a note about the rest.
  const body: string[] = [];
  let used = markers.join("\n").length + 2;
  let cut = headings.length;
  for (const line of headings) {
    const shown = show(line);
    if (used + shown.length + 1 > budget - 140) break;
    body.push(shown);
    used += shown.length + 1;
    cut -= 1;
  }
  const dropped = headings.filter((line) => line.interactive).length - body.filter((entry) => REF.test(entry)).length;
  body.push(`… ${cut} more lines not shown (${dropped} interactive). Ask for a full snapshot, or page_read for the text.`);
  return { text: wrap(body), shown: body.length - 1, of, interactive, level: 3 };
}

/** A line as it reads, without indentation or the ref that renumbers between snapshots. */
const normalise = (raw: string): string => raw.trim().replace(/\s*\[ref=e\d+\]/g, "");

const REF_ID = /\[ref=(e\d+)\]/g;

/** Every ref in a tree, to tell a quiet re-render from a page that truly did not move. */
const refsIn = (tree: string): Set<string> => new Set(Array.from(tree.matchAll(REF_ID), (match) => match[1] as string));

const sameRefs = (before: Set<string>, after: Set<string>): boolean =>
  before.size === after.size && [...before].every((ref) => after.has(ref));

export interface PageChange {
  /** none: identical; some: parts changed; page: mostly different, read it as a new page. */
  readonly kind: "none" | "some" | "page";
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly addedCount: number;
  readonly removedCount: number;
  /**
   * Whether the refs themselves changed. Text and refs are separate questions:
   * a page that re-renders to exactly the same words still renumbers its refs,
   * and a bot told "nothing changed, your refs still apply" would then act on
   * handles that no longer exist.
   */
  readonly refsMoved: boolean;
}

const CHANGE_LINES = 40;
const NEW_PAGE_RATIO = 0.6;

/**
 * What an action did to the page: the lines that appeared, with their refs,
 * and the lines that went. Compared without refs, since those renumber; with
 * the URL, since the same tree at a new address is a new page.
 */
export function compareTrees(before: { url: string; tree: string }, after: { url: string; tree: string }): PageChange {
  const count = (tree: string) => {
    const map = new Map<string, number>();
    for (const raw of tree.split("\n")) {
      const key = normalise(raw);
      if (key === "" || MARKER.test(key) || key.startsWith("…")) continue;
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return map;
  };
  const was = count(before.tree);
  const now = count(after.tree);
  const added: string[] = [];
  const removed: string[] = [];
  const spare = new Map(was);
  for (const raw of after.tree.split("\n")) {
    const key = normalise(raw);
    if (key === "" || MARKER.test(key) || key.startsWith("…")) continue;
    const left = spare.get(key) ?? 0;
    if (left > 0) spare.set(key, left - 1);
    else added.push(raw.trim());
  }
  for (const [key, n] of was) removed.push(...Array.from({ length: Math.max(0, n - (now.get(key) ?? 0)) }, () => key));

  const size = Math.max(1, Math.max([...was.values()].reduce((a, b) => a + b, 0), [...now.values()].reduce((a, b) => a + b, 0)));
  const ratio = (added.length + removed.length) / size;
  const kind: PageChange["kind"] =
    added.length + removed.length === 0 && before.url === after.url ? "none" : before.url !== after.url || ratio > NEW_PAGE_RATIO ? "page" : "some";
  return {
    kind,
    added: added.slice(0, CHANGE_LINES).map((line) => clip(line, 160)),
    removed: removed.slice(0, CHANGE_LINES).map((line) => clip(line, 160)),
    addedCount: added.length,
    removedCount: removed.length,
    refsMoved: !sameRefs(refsIn(before.tree), refsIn(after.tree)),
  };
}

export interface Look {
  readonly url: string;
  readonly page: string;
  readonly shown: { readonly lines: number; readonly of: number; readonly interactive: number; readonly trimmed: boolean };
  /** The untrimmed tree, kept for the next comparison. */
  readonly tree: string;
}

const lastLook = new Map<string, Look>();

/**
 * Reads the page after it has settled: the load event, then a moment for the
 * app to re-render. `full` asks for agent-browser's whole tree instead of the
 * trimmed one.
 */
export async function look(ctx: ToolContext, options: { readonly full?: boolean } = {}): Promise<Look | { readonly error: string; readonly detail: string }> {
  await browser(ctx, ["wait", "--load", "domcontentloaded"]);
  const settle = settleMs();
  if (settle > 0) await browser(ctx, ["wait", String(settle)]);
  const snapshot = await browser(ctx, ["snapshot", "-c"]);
  if (!snapshot.ok) return { error: snapshot.error ?? "The page could not be read.", detail: snapshot.output };
  const at = await browser(ctx, ["get", "url"]);
  const url = at.ok ? at.output.trim().slice(0, 500) : "";
  const trimmed = options.full === true ? null : trimTree(snapshot.output, pageBudget());
  const result: Look = {
    url,
    page: trimmed === null ? snapshot.output : trimmed.text,
    shown:
      trimmed === null
        ? { lines: snapshot.output.split("\n").length, of: snapshot.output.split("\n").length, interactive: 0, trimmed: false }
        : { lines: trimmed.shown, of: trimmed.of, interactive: trimmed.interactive, trimmed: trimmed.level > 0 },
    tree: snapshot.output,
  };
  lastLook.set(ctx.session.id, result);
  return result;
}

export const isLook = (value: Look | { error: string }): value is Look => "page" in value;

/**
 * Drops the baseline this session compares against.
 *
 * Anything that moves the page without going through `look` — reading a URL as
 * text, a person working in the browser during a takeover — leaves that
 * baseline describing a page the bot is no longer on. Comparing the next
 * action against it would report the whole new page as that action's doing.
 * Forgetting it makes the next action say "read the page" instead.
 */
export const forgetLook = (ctx: ToolContext): void => {
  lastLook.delete(ctx.session.id);
};

export interface Acted {
  readonly ok: true;
  readonly url: string;
  readonly changed: PageChange["kind"];
  readonly added?: readonly string[];
  readonly removed?: readonly string[];
  readonly addedCount?: number;
  readonly removedCount?: number;
  /** The page as it is now; null when nothing changed and the old refs still stand. */
  readonly page: string | null;
  readonly shown: Look["shown"] | null;
  readonly note: string;
}

/**
 * Runs one action and reports what it did to the page. The page comes back
 * only when it changed: an action that changed nothing says so, which is the
 * signal a Bot needs to stop retrying the same click.
 */
export async function act(ctx: ToolContext, args: readonly string[]): Promise<Acted | { readonly ok: false; readonly error: string; readonly detail: string }> {
  const before = lastLook.get(ctx.session.id);
  const result = await browser(ctx, args);
  if (!result.ok) return { ok: false, error: result.error ?? "The action failed.", detail: result.output };
  await refreshScreen(ctx);
  const after = await look(ctx);
  if (!isLook(after)) return { ok: false, error: after.error, detail: after.detail };
  if (before === undefined) {
    return { ok: true, url: after.url, changed: "page", page: after.page, shown: after.shown, note: "Read the page to see where you are." };
  }
  const change = compareTrees(before, after);
  if (change.kind === "none") {
    const stale = change.refsMoved;
    return {
      ok: true,
      url: after.url,
      changed: "none",
      // The words are the same, but re-rendered refs are not: hand back the
      // page so the bot has handles that exist.
      page: stale ? after.page : null,
      shown: stale ? after.shown : null,
      note: stale
        ? "Nothing on the page changed, but it re-rendered and the refs were renumbered: use the refs below, not the ones you had. If you expected a change, the element was covered, disabled, or not the one you meant; do not repeat the same action."
        : "Nothing on the page changed. Your previous refs still apply. If you expected a change, the element was covered, disabled, or not the one you meant; do not repeat the same action.",
    };
  }
  return {
    ok: true,
    url: after.url,
    changed: change.kind,
    added: change.added,
    removed: change.removed,
    addedCount: change.addedCount,
    removedCount: change.removedCount,
    page: after.page,
    shown: after.shown,
    note:
      change.kind === "page"
        ? "The page changed substantially; read it as a new page. Refs from before are stale."
        : "Only part of the page changed; `added` lists what appeared, with fresh refs.",
  };
}
