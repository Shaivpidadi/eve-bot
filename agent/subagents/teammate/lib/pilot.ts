/**
 * The browser pilot's pure parts: reading an accessibility snapshot into
 * elements, turning those into the options a decision model chooses from, and
 * the rules about which actions it may take on its own. Nothing here touches
 * the browser or the network, so it can be reasoned about and tested alone.
 *
 * The idea: a Bot's browser work is a loop of "look at the page, pick the next
 * element, act". The looking and picking do not need a language model; they
 * need a fast, calibrated choice among a few hundred named things. Jev makes
 * that choice from explicit state for a fraction of a cent, so the language
 * model is spent on planning and on the steps that carry consequences.
 */

export interface PageElement {
  /** The `@ref` handle without the `@`, such as `e12`. */
  readonly ref: string;
  readonly role: string;
  readonly name: string;
  /** Extra state agent-browser noted, such as `checked` or `disabled`. */
  readonly flags: readonly string[];
  readonly depth: number;
}

/** Roles worth offering as targets; the rest of the tree is context. */
const INTERACTIVE = new Set([
  "button", "link", "textbox", "searchbox", "combobox", "checkbox", "radio", "switch", "menuitem",
  "menuitemcheckbox", "menuitemradio", "tab", "option", "treeitem", "slider", "spinbutton", "listbox", "gridcell", "cell", "row",
]);
const TYPEABLE = new Set(["textbox", "searchbox", "combobox", "spinbutton"]);

/** Lines look like `  - button "Send" [ref=e12] [disabled]`, with the name optional. */
const LINE = /^(\s*)-\s+([a-zA-Z]+)(?:\s+"((?:[^"\\]|\\.)*)")?(?:\s+[^\[\n]*)?((?:\s*\[[^\]]*\])*)\s*$/;
const REF = /\[ref=(e\d+)\]/;
const FLAG = /\[([a-zA-Z-]+)(?:=[^\]]*)?\]/g;

/** Every element with a ref in a snapshot, in page order. */
export function parseSnapshot(snapshot: string): PageElement[] {
  const elements: PageElement[] = [];
  for (const raw of snapshot.split("\n")) {
    const ref = REF.exec(raw)?.[1];
    if (ref === undefined) continue;
    const match = LINE.exec(raw);
    const flags: string[] = [];
    for (const flag of raw.matchAll(FLAG)) {
      if (flag[1] !== undefined && flag[1] !== "ref") flags.push(flag[1]);
    }
    elements.push({
      ref,
      role: (match?.[2] ?? "element").toLowerCase(),
      name: (match?.[3] ?? "").replace(/\\"/g, '"').replace(/\s+/g, " ").trim(),
      flags,
      depth: Math.floor((match?.[1]?.length ?? 0) / 2),
    });
  }
  return elements;
}

/**
 * Controls that carry consequences the Bot, not the pilot, must own: sending,
 * paying, deleting, publishing, signing out. The pilot never clicks these; it
 * stops and names them, and the Bot decides with its own judgment and the
 * approval gates that apply.
 */
const CONSEQUENTIAL =
  /\b(send|submit|pay|buy|purchase|checkout|place order|order now|delete|remove|erase|discard|confirm|publish|post|tweet|share|transfer|withdraw|approve|reject|sign out|log out|logout|unsubscribe|cancel (?:subscription|plan|order)|archive|mark as (?:read|spam)|report|block|accept invitation|grant|authorize)\b/i;

export const isConsequential = (element: PageElement): boolean =>
  (element.role === "button" || element.role === "menuitem" || element.role === "link") && CONSEQUENTIAL.test(element.name);

/** The pilot's own moves, apart from acting on an element. */
export const CONTROL_OPTIONS = {
  done: "The goal is reached: the current page already shows what was asked for, and nothing else needs clicking.",
  scroll: "Scroll down. The element that is needed is probably further down the page and not in view yet.",
  back: "Go back to the previous page; this one was a wrong turn.",
  wait: "The page is still loading or changing; wait a moment and look again before acting.",
  needs_human:
    "A sign-in form, password or one-time code, CAPTCHA, passkey or device prompt, or a payment page: a step only a person may do. Stop here and hand over.",
  stuck: "None of the listed actions moves toward the goal, or the next step needed is a control that is not listed. Hand back to the Bot.",
} as const;

export type ControlOption = keyof typeof CONTROL_OPTIONS;

/** Jev decides among at most 255 options; this leaves room for the controls. */
export const MAX_ELEMENT_OPTIONS = 220;

export interface PilotOptions {
  /** Option key to description, ready for a decision. */
  readonly options: Record<string, string>;
  /** Consequential controls on the page that were deliberately left out. */
  readonly withheld: PageElement[];
  /** Interactive elements that did not fit under the option cap. */
  readonly overflow: number;
}

/**
 * The choices the pilot may make on this page: click an interactive element,
 * type one of the Bot's provided values into a field, or one of the controls.
 * Option keys are `click:e12` and `fill:e7=fieldKey`, so the decision maps
 * straight back to an action.
 */
export function buildOptions(elements: readonly PageElement[], inputs: Readonly<Record<string, string>>): PilotOptions {
  const options: Record<string, string> = {};
  const withheld: PageElement[] = [];
  const inputKeys = Object.keys(inputs);
  let used = 0;
  let overflow = 0;

  for (const element of elements) {
    if (!INTERACTIVE.has(element.role)) continue;
    if (element.flags.includes("disabled")) continue;
    if (isConsequential(element)) {
      withheld.push(element);
      continue;
    }
    const label = element.name === "" ? `${element.role} (unnamed)` : `${element.role} "${element.name}"`;
    const state = element.flags.length > 0 ? ` [${element.flags.join(", ")}]` : "";
    const wants = TYPEABLE.has(element.role) ? 1 + inputKeys.length : 1;
    if (used + wants > MAX_ELEMENT_OPTIONS) {
      overflow += 1;
      continue;
    }
    options[`click:${element.ref}`] = `Click the ${label}${state}.`;
    used += 1;
    if (TYPEABLE.has(element.role)) {
      for (const key of inputKeys) {
        options[`fill:${element.ref}=${key}`] = `Type the provided "${key}" value into the ${label}${state}.`;
        used += 1;
      }
    }
  }
  for (const [key, description] of Object.entries(CONTROL_OPTIONS)) options[key] = description;
  return { options, withheld, overflow };
}

export type PilotAction =
  | { readonly kind: "click"; readonly ref: string }
  | { readonly kind: "fill"; readonly ref: string; readonly input: string }
  | { readonly kind: ControlOption };

/** The action an option key stands for. */
export function actionFor(key: string): PilotAction | null {
  const click = /^click:(e\d+)$/.exec(key);
  if (click?.[1] !== undefined) return { kind: "click", ref: click[1] };
  const fill = /^fill:(e\d+)=(.+)$/.exec(key);
  if (fill?.[1] !== undefined && fill[2] !== undefined) return { kind: "fill", ref: fill[1], input: fill[2] };
  return key in CONTROL_OPTIONS ? { kind: key as ControlOption } : null;
}

/** A short, stable fingerprint of a page, to notice when an action changed nothing. */
export function pageFingerprint(url: string, elements: readonly PageElement[]): string {
  return `${url}|${elements.map((element) => `${element.role}:${element.name}`).join("|")}`.slice(0, 20_000);
}

/** The snapshot trimmed to what a decision needs: the tree, without agent-browser's boundary markers. */
export function compactSnapshot(snapshot: string, maxChars: number): string {
  const lines = snapshot
    .split("\n")
    .filter((line) => line.trim() !== "" && !/^-{3,}|^={3,}|^\[(?:BEGIN|END) /.test(line.trim()));
  let out = lines.join("\n");
  if (out.length > maxChars) out = `${out.slice(0, maxChars)}\n… (${out.length - maxChars} more characters not shown)`;
  return out;
}
