import type { UserPart } from "eve/events";

/**
 * Small readers over eve's session facts (stream version 27), shared by the
 * hooks, the routes, and the console.
 */

/** The text a person sent, from a consumed delivery's parts. */
export const textOfParts = (parts: readonly UserPart[] | undefined): string =>
  (parts ?? [])
    .map((part) => (part.kind === "text" ? part.text : ""))
    .filter((text) => text !== "")
    .join("\n");

/** A finished part's text: a reply or narration's value, as a string. */
export const textOfValue = (value: unknown): string => (typeof value === "string" ? value : "");

/**
 * An event as the console's thread reader receives it from the room's stream
 * route: eve's event, plus where it sits in the whole thread. A thread can run
 * across several sessions (started over, branched, moved to a fresh one), and
 * each session numbers its stored lines from zero, so the route adds:
 *
 * - `key`: the event's identity in the thread, stable across reads, which the
 *   console keys items on and a branch names its point by;
 * - `cursor`: the thread line to read from next, set once the event's whole
 *   line has arrived, so a reconnect never resumes halfway through a line.
 */
export interface ThreadEvent {
  readonly type: string;
  readonly data?: unknown;
  readonly scope?: { readonly turnId?: string; readonly runId?: string };
  readonly meta?: { readonly position?: { readonly line: number; readonly index: number }; readonly at?: string; readonly endOfLine?: boolean };
  readonly key: string;
  readonly cursor?: number;
}

/** An event's identity in a thread whose earlier sessions recorded `offset` lines. */
export const threadKey = (offset: number, position: { readonly line: number; readonly index: number }): string => `e${offset + position.line}_${position.index}`;

/** eve's event with its place in the thread (see `ThreadEvent`). */
export function inThread(event: { readonly meta?: { readonly position?: { readonly line: number; readonly index: number }; readonly endOfLine?: boolean } }, offset: number): ThreadEvent {
  const position = event.meta?.position ?? { line: 0, index: 0 };
  const whole = event.meta?.endOfLine !== false;
  return { ...(event as ThreadEvent), key: threadKey(offset, position), ...(whole ? { cursor: offset + position.line + 1 } : {}) };
}
