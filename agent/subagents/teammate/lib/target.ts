/**
 * How a tool says which element it means.
 *
 * A `@ref` from the last snapshot is the precise way, and the cheap one. But a
 * bot that knows the control it wants — the Send button, the field labelled
 * Email — should not have to read a whole page to find its number. agent-browser
 * locates elements semantically with `find`, so a tool can take the name of a
 * control instead, and the tree read that would have preceded it disappears.
 *
 * Only `find`'s own actions can be reached this way (click, fill, check, hover,
 * text); anything else needs a ref or a selector.
 */

export const LOCATORS = ["ref", "text", "label", "role", "placeholder", "testid"] as const;
export type Locator = (typeof LOCATORS)[number];

export interface Target {
  /** A `@ref`, a CSS selector, or the text/label/role to look for. */
  readonly target: string;
  /** How to read `target`. Absent, or `ref`, means a ref or CSS selector. */
  readonly by?: Locator;
  /** The accessible name, when `by` is `role`. Ignored otherwise. */
  readonly name?: string;
}

/** The agent-browser arguments that run `action` against the element `target` names. */
export function targetArgs(target: Target, action: string, text?: string): string[] {
  const value = text === undefined ? [] : [text];
  if (target.by === undefined || target.by === "ref") {
    return [action, target.target, ...value];
  }
  const name = target.by === "role" && target.name !== undefined && target.name !== "" ? ["--name", target.name] : [];
  return ["find", target.by, target.target, action, ...value, ...name];
}

/** What to say when an element could not be acted on, whichever way it was named. */
export function missHint(target: Target): string {
  return target.by === undefined || target.by === "ref"
    ? "A covered or stale ref is the usual cause. Take a fresh snapshot, dismiss anything overlaying the element, and try again."
    : `Nothing on the page matched ${target.by} "${target.target}". Take a snapshot and use the @ref, or try the exact wording the page shows.`;
}
