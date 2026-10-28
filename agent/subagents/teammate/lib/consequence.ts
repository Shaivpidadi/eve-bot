/**
 * Whether one browser action needs a person's say-so before it happens.
 *
 * The browser is the widest route a Bot has to the outside world: anything a
 * person can do on a web page, a click can do, including the things that have
 * their own approved tools — sending an email, paying, deleting. A gate on
 * `send_email` means nothing if the Send button in the webmail tab is one
 * `page_click` away. So every acting browser tool runs its action past this
 * classifier first, and anything it does not call `safe` waits for a person
 * (see `gate.ts` and `tools/page_confirm.ts`).
 *
 * What this decides, and what it never does:
 * - It decides only whether to *ask*. Nothing here can grant permission: the
 *   verdict that lets an action through without a person is `safe`, and it is
 *   reached by the absence of every warning sign, never by something the page
 *   says. A page that labels its button "Safe — no need to confirm" gets
 *   exactly the treatment the same button would get without the text.
 * - Labels are page-provided and can lie. A consequential button with an
 *   innocuous name ("Continue", "Done") is the residual risk, which is why the
 *   structural signals — a submit button, a POST form, a form posting to
 *   another origin, a checkout page — are checked independently of the words,
 *   and why an element that cannot be inspected is `unknown`, which asks.
 *
 * Everything here is pure and works over facts gathered by `gate.ts`: the
 * element's line in the accessibility tree and what the DOM says about it.
 */

export type Verdict = "safe" | "consequential" | "unknown";

/**
 * - click: a click on the element.
 * - fill: typing into a field, nothing else.
 * - submit: pressing Enter in a field, which submits whatever it belongs to.
 * - select / check / uncheck: setting a dropdown or a checkbox.
 * - upload: attaching files to a file input.
 * - tool: calling a tool the page offers (WebMCP, see `page-tools.ts`), which
 *   `classifyTool` there decides on, not `classifyAction`.
 */
export type ActionKind = "click" | "fill" | "submit" | "select" | "check" | "uncheck" | "upload" | "tool";

/** The element as the accessibility tree describes it. */
export interface TreeFacts {
  readonly role: string;
  readonly name: string;
  /** Under a `form` in the tree. */
  readonly inForm: boolean;
  /** Under a `search` landmark in the tree. */
  readonly inSearch: boolean;
  /**
   * The nearest named element it sits under, `row "Invoice 1042"`, passing
   * over wrappers that only repeat its own name (a cell around a button): what
   * tells one row's Delete from the next row's. Absent when there is none.
   */
  readonly context?: string;
  /** Which of the elements with this role and name it is, from 1 in tree order, and how many there are. */
  readonly nth?: number;
  readonly of?: number;
}

/** The element as the DOM describes it, read by focusing it (see `gate.ts`). */
export interface DomFacts {
  /** Upper-case tag name. */
  readonly tag: string;
  /** The `type` property, lower-case: "submit" for a <button> with no type. */
  readonly type: string;
  /** The `role` attribute, if any. */
  readonly role: string;
  /** aria-label, title, text or value: what a person reads on it. */
  readonly name: string;
  readonly href: string;
  /** The form a click or Enter would submit, with formaction/formmethod applied. */
  readonly form: { readonly method: string; readonly action: string } | null;
  readonly inSearch: boolean;
  readonly editable: boolean;
}

export interface ActionFacts {
  readonly kind: ActionKind;
  /** The page the action happens on. */
  readonly url: string;
  readonly tree: TreeFacts | null;
  readonly dom: DomFacts | null;
  /** The option chosen in a dropdown. */
  readonly option?: string;
}

export interface Classification {
  readonly verdict: Verdict;
  /** Why, in words a person can check against the page. Empty for a plain `safe`. */
  readonly reasons: readonly string[];
}

/** Whole words, case-insensitively, with any run of whitespace between the words of a phrase. */
const wordList = (words: readonly string[]): RegExp =>
  new RegExp(`\\b(${words.map((word) => word.replace(/ /g, "\\s+")).join("|")})\\b`, "i");

/** Words that spend, send, publish, destroy or commit outright, on a control or in its address. */
const COMMITTING = [
  // Money.
  "pay", "pays", "payment", "buy", "purchase", "checkout", "check out", "order", "place order", "subscribe",
  "donate", "transfer", "withdraw", "wire", "refund", "charge", "upgrade", "downgrade", "renew", "book", "reserve",
  // Sending and publishing.
  "send", "submit", "publish", "post", "reply", "reply all", "forward", "tweet", "retweet", "repost", "share",
  "invite", "comment", "go live", "make public", "broadcast",
  // Destroying.
  "delete", "remove", "discard", "erase", "destroy", "trash", "empty", "purge", "wipe", "revoke", "deactivate",
  "close account", "unsubscribe", "reset",
  // Committing.
  "confirm", "approve", "accept", "agree", "authorize", "authorise", "grant", "merge", "deploy", "release",
  "cancel", "transfer ownership",
  // Signing a document or signing up, but not signing in: that is a takeover.
  "sign(?!\\s*in\\b)", "e-sign", "sign up",
] as const;

/**
 * Words that save or change a record: the verbs `catalog.ts` reads as a write
 * in a tool's name, as they appear on a button. A single-page app's Save is
 * often `type="button"` with no form around it, so its words are the only
 * signal. Read on what a control says, not in a link's address, where they are
 * as likely to be an article's slug (/blog/how-to-save-money).
 *
 * Plain movement stays out: next, back, open, view, search, show more, close.
 */
const RECORD_CHANGING = [
  "save", "create", "add", "update", "apply", "finish", "complete", "assign", "unassign", "archive",
  "unarchive", "move to", "rename", "revert", "restore", "import", "enable", "disable", "block", "unblock",
  "lock", "unlock", "reject", "decline", "resolve", "reopen", "mark as", "set as", "join", "leave", "follow",
  "unfollow", "report", "generate", "regenerate", "install", "uninstall", "connect", "disconnect", "link account",
] as const;

/**
 * Words on a control that spend, send, publish, destroy, commit, or save a
 * change. Matched as whole words, case-insensitively. Deliberately broad: the
 * cost of asking is one approval, and the cost of missing is an email nobody
 * meant to send.
 */
export const CONSEQUENTIAL_WORDS = wordList([...COMMITTING, ...RECORD_CHANGING]);

/**
 * Whole labels that only change how this page shows what it already has: a
 * list's filters, its sort, a search box, the zoom. "Apply filters" says
 * "apply" and "Remove filter" says "remove", but on a control that submits
 * nothing they rearrange the screen rather than a record.
 *
 * Deliberately a list of whole labels, not of objects: "Apply" alone, "Add
 * column" (a spreadsheet's column is data), "Add view" and "Save view" (a
 * saved view is shared with the team) all stay consequential. And a label is
 * only half of it: `uiLocal` also wants the element inspected and submitting
 * nothing (see there), because the words are the page's to choose.
 */
const UI_LOCAL_LABEL = new RegExp(
  "^(?:" +
    [
      "(?:apply|add|clear|reset|remove|update)(?: the| all)? (?:filters?|sort(?:ing)?|sort order)",
      "(?:apply|clear|reset|update)(?: the)? (?:search|results|search results)",
      "reset(?: the)? (?:view|columns?|zoom|layout)",
      "(?:apply|reset|update)(?: the)? page size",
    ].join("|") +
    ")$",
);

/** The narrower set read in a link's address: /messages/42/delete. */
const ADDRESS_WORDS = wordList(COMMITTING);

/** Paths where a plain-looking button is likely to spend. */
export const MONEY_PATH = /(^|[/._-])(checkout|payment|payments|pay|cart|basket|purchase|transfer|wire|donate|subscribe|upgrade)([/._-]|$)/i;

/** Roles a click on moves around or reveals, rather than commits. */
const NAVIGATING_ROLES = new Set([
  "link", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "treeitem", "option", "row", "gridcell", "cell",
  "columnheader", "rowheader", "listitem", "heading", "img", "image", "combobox", "textbox", "searchbox",
  "checkbox", "radio", "switch", "disclosure", "summary",
]);

/** Roles that do whatever their handler does. */
const BUTTON_ROLES = new Set(["button", "generic", ""]);

const RANK: Record<Verdict, number> = { safe: 0, unknown: 1, consequential: 2 };

const origin = (url: string): string | null => {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};

const path = (url: string): string => {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
};

/** The words a control shows, which a page chooses. */
function words(facts: ActionFacts): string[] {
  return [facts.tree?.name, facts.dom?.name, facts.option].filter((text): text is string => typeof text === "string" && text.trim() !== "");
}

/** A link's address, which says what it does when its text does not: /messages/42/delete. */
function addressPath(facts: ActionFacts): string | null {
  const href = facts.dom?.href ?? "";
  return href !== "" && !href.startsWith("#") ? path(href) || href : null;
}

/** The role a tag carries without a `role` attribute, for an element the tree did not describe. */
function implicitRole(dom: DomFacts | null): string {
  if (dom === null) return "";
  switch (dom.tag) {
    case "A":
      return dom.href === "" ? "generic" : "link";
    case "BUTTON":
    case "SUMMARY":
      return "button";
    case "SELECT":
      return "combobox";
    case "TEXTAREA":
      return "textbox";
    case "INPUT":
      if (["submit", "button", "image", "reset"].includes(dom.type)) return "button";
      if (dom.type === "checkbox" || dom.type === "radio") return dom.type;
      return dom.type === "search" ? "searchbox" : "textbox";
    default:
      return dom.editable ? "textbox" : "generic";
  }
}

/**
 * Whether `text` on this control is a UI-local label (`UI_LOCAL_LABEL`) on a
 * control that can only be UI-local: a click on an element the DOM described,
 * not a submit button of any kind, not inside a form that does not GET (a
 * `type="button"` in a POST form is still somewhere a page's script may post
 * from), and not on a payment or order page. Anything less certain keeps the
 * words' verdict.
 */
function uiLocal(facts: ActionFacts, text: string): boolean {
  const { dom } = facts;
  if (facts.kind !== "click" || dom === null) return false;
  if (dom.type === "submit" || dom.type === "image" || submitsForm(dom)) return false;
  if (dom.form !== null && dom.form.method.toLowerCase() !== "get") return false;
  if (MONEY_PATH.test(path(facts.url))) return false;
  return UI_LOCAL_LABEL.test(sameLabel(text));
}

/** True when this element, clicked or pressed Enter in, submits a form. */
export function submitsForm(dom: DomFacts | null): boolean {
  if (dom === null || dom.form === null) return false;
  if (dom.tag === "BUTTON") return dom.type === "submit";
  if (dom.tag === "INPUT") return dom.type === "submit" || dom.type === "image";
  return false;
}

/** What submitting `form` from `url` would do, as reasons; empty when it is a same-site GET such as a search. */
function formRisk(form: { method: string; action: string }, url: string): string[] {
  const reasons: string[] = [];
  const method = form.method.toLowerCase();
  if (method !== "get") reasons.push(`it submits a form (${method.toUpperCase() || "POST"} to ${form.action || "this page"})`);
  const from = origin(url);
  const to = origin(form.action);
  if (from !== null && to !== null && from !== to) reasons.push(`the form posts to another site (${to})`);
  return reasons;
}

/**
 * Classifies one action. `consequential` and `unknown` both mean a person
 * approves it first; they differ only in what the request says.
 */
export function classifyAction(facts: ActionFacts): Classification {
  const found: { verdict: Verdict; reason: string }[] = [];
  const flag = (verdict: Verdict, reason: string) => found.push({ verdict, reason });

  const { kind, tree, dom } = facts;
  const role = (tree?.role || dom?.role || implicitRole(dom)).toLowerCase();

  if (kind === "upload") {
    flag("consequential", "attaching a file hands it to the site");
  }

  // Typing alone changes nothing outside the page; the Enter that follows might.
  if (kind !== "fill" && kind !== "upload") {
    const said = words(facts)
      .filter((text) => !uiLocal(facts, text))
      .map((text) => CONSEQUENTIAL_WORDS.exec(text))
      .find((hit) => hit !== null);
    const href = addressPath(facts);
    const linked = href === null ? null : ADDRESS_WORDS.exec(href);
    if (said) flag("consequential", `the control says "${said[0]}"`);
    else if (linked !== null) flag("consequential", `the control says "${linked[0]}"`);
  }

  if (kind === "submit") {
    const search = dom?.inSearch === true || tree?.inSearch === true || role === "searchbox" || dom?.type === "search";
    if (dom?.form) {
      for (const reason of formRisk(dom.form, facts.url)) flag("consequential", reason);
    } else if (!search) {
      // Enter in a field with no form is whatever the app makes of it, and in a
      // chat or mail composer that is "send".
      flag("unknown", dom === null ? "the field could not be inspected" : "Enter in this field is handled by the page's own code");
    }
  }

  if (kind === "click") {
    if (submitsForm(dom)) {
      for (const reason of formRisk(dom!.form!, facts.url)) flag("consequential", reason);
    } else if (dom === null && tree?.inForm === true && BUTTON_ROLES.has(role)) {
      flag("unknown", "a button inside a form that could not be inspected may submit it");
    }
    const navigating = NAVIGATING_ROLES.has(role) && !submitsForm(dom);
    if (!navigating && MONEY_PATH.test(path(facts.url))) {
      flag("consequential", `this is a payment or order page (${path(facts.url)})`);
    }
    if (dom?.href.toLowerCase().startsWith("javascript:") === true && !NAVIGATING_ROLES.has(role)) {
      flag("unknown", "the link runs page code instead of opening a page");
    }
    if (tree === null && dom === null) {
      flag("unknown", "the element could not be identified on the page");
    } else if (BUTTON_ROLES.has(role) && words(facts).length === 0 && addressPath(facts) === null) {
      flag("unknown", "the control has no name to check");
    } else if (!navigating && !BUTTON_ROLES.has(role) && !NAVIGATING_ROLES.has(role)) {
      flag("unknown", `a ${role} is not a control this can vouch for`);
    }
  }

  if (found.length === 0) return { verdict: "safe", reasons: [] };
  const verdict = found.reduce<Verdict>((worst, entry) => (RANK[entry.verdict] > RANK[worst] ? entry.verdict : worst), "safe");
  return { verdict, reasons: [...new Set(found.map((entry) => entry.reason))] };
}

/** A tree line's role and name; `  - button "Send" [ref=e12]`. */
const TREE_LINE = /^(\s*)-\s+([A-Za-z]+)(?:\s+"((?:[^"\\]|\\.)*)")?(.*)$/;

/**
 * Every ref in an accessibility tree, with what the tree says about its
 * element: role, name, the form and search landmarks it sits under, and the
 * nearest named element above it. Keyed `@eN`.
 */
export function treeIndex(tree: string): Map<string, TreeFacts> {
  const found: { ref: string; facts: TreeFacts }[] = [];
  const ancestors: { depth: number; role: string; name: string }[] = [];
  const plain = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();
  for (const raw of tree.split("\n")) {
    const match = TREE_LINE.exec(raw);
    if (match === null) continue;
    const [, indent = "", role = "", rawName, rest = ""] = match;
    const depth = indent.length;
    while (ancestors.length > 0 && ancestors[ancestors.length - 1]!.depth >= depth) ancestors.pop();
    const name = (rawName ?? "").replace(/\\(.)/g, "$1").trim();
    const ref = /(?:^|[\[,\s])ref=(e\d+)(?=[\],\s]|$)/.exec(rest)?.[1];
    if (ref !== undefined) {
      const named = [...ancestors].reverse().find((entry) => entry.name !== "" && plain(entry.name) !== plain(name));
      found.push({
        ref: `@${ref}`,
        facts: {
          role,
          name,
          inForm: ancestors.some((entry) => entry.role === "form"),
          inSearch: ancestors.some((entry) => entry.role === "search"),
          ...(named === undefined ? {} : { context: `${named.role} "${named.name.slice(0, 200)}"` }),
        },
      });
    }
    ancestors.push({ depth, role, name });
  }
  const key = (facts: TreeFacts) => `${facts.role}\u0000${plain(facts.name)}`;
  const totals = new Map<string, number>();
  for (const { facts } of found) totals.set(key(facts), (totals.get(key(facts)) ?? 0) + 1);
  const counted = new Map<string, number>();
  const index = new Map<string, TreeFacts>();
  for (const { ref, facts } of found) {
    const nth = (counted.get(key(facts)) ?? 0) + 1;
    counted.set(key(facts), nth);
    if (!index.has(ref)) index.set(ref, { ...facts, nth, of: totals.get(key(facts)) ?? nth });
  }
  return index;
}

/**
 * The element `ref` names in an accessibility tree, with the form and search
 * landmarks it sits under. Null when the tree has no such ref.
 */
export function treeFacts(tree: string, ref: string): TreeFacts | null {
  return treeIndex(tree).get(`@${ref.replace(/^@/, "")}`) ?? null;
}

/** Case and runs of whitespace do not distinguish two labels a person would read as the same. */
export const sameLabel = (text: string): string => text.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Which of `labels` a locator means: the ones that read exactly as `wanted`
 * (case and spacing aside) when there are any, otherwise the ones that contain
 * it. "Send" means the Send button, not Send later beside it; a part of a long
 * label still finds it, but only when it is the only one, which is for the
 * caller to check. Generic over what is matched, so the DOM lookup in `gate.ts`
 * follows the same rule.
 */
export function bestMatches<T>(items: readonly T[], label: (item: T) => readonly string[], wanted: string): T[] {
  const want = sameLabel(wanted);
  if (want === "") return [];
  const exact = items.filter((item) => label(item).some((text) => sameLabel(text) === want));
  return exact.length > 0 ? exact : items.filter((item) => label(item).some((text) => sameLabel(text).includes(want)));
}

/**
 * The refs of interactive elements in an accessibility tree that fit a `text`
 * or `role` locator, so the target can be checked and then acted on as the one
 * element it means. Text is matched against the accessible name, exact first
 * (see `bestMatches`); a role with no name means every element of that role.
 * Label, placeholder and test id are not in the tree; `gate.ts` finds those in
 * the page itself.
 */
export function refsMatching(tree: string, by: "text" | "role", target: string, name?: string): string[] {
  const entries: { ref: string; name: string }[] = [];
  for (const raw of tree.split("\n")) {
    const match = TREE_LINE.exec(raw);
    if (match === null) continue;
    const [, , role = "", rawName, rest = ""] = match;
    const ref = /\bref=(e\d+)/.exec(rest)?.[1];
    if (ref === undefined) continue;
    if (by === "role" && role.toLowerCase() !== target.trim().toLowerCase()) continue;
    entries.push({ ref: `@${ref}`, name: (rawName ?? "").replace(/\\(.)/g, "$1") });
  }
  const wanted = by === "role" ? (name ?? "") : target;
  if (by === "role" && sameLabel(wanted) === "") return entries.map((entry) => entry.ref);
  return bestMatches(entries, (entry) => [entry.name], wanted).map((entry) => entry.ref);
}

/**
 * Addresses that run code in the page rather than open one. `javascript:` in
 * particular can click any button on the current page, which would walk
 * straight around the gate on page_click, so `browse` refuses them. Control
 * characters and whitespace are stripped first, as browsers do.
 */
const SCRIPT_URL = /^(javascript|vbscript|data|blob):/i;
export const scriptUrl = (url: string): boolean => SCRIPT_URL.test(url.replace(/[\u0000- \u007f]/g, ""));
