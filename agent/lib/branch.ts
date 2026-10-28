import { transcriptOf } from "eve/client";
import type { SessionStreamEvent } from "eve/client";

import { textOfParts, textOfValue, threadKey } from "./events";

/** The newest messages a branched session starts from. */
export const BRANCH_MESSAGES = 40;

/** The point a person went back to, and the conversation up to and including it. */
export interface BranchPoint {
  readonly eventAt: string;
  readonly text: string;
  readonly messages: readonly { readonly role: string; readonly text: string }[];
}

interface Event {
  readonly type?: string;
  readonly data?: { readonly parts?: readonly { readonly kind: string; readonly text?: string }[]; readonly kind?: string; readonly value?: unknown };
  readonly meta?: { readonly position?: { readonly line: number; readonly index: number }; readonly at?: string };
}

/** What a person said, or a finished text the Bot wrote: the only things a branch can go back to. */
function said(event: Event): { readonly role: "user" | "assistant"; readonly text: string } | null {
  if (event.type === "delivery.consumed") return { role: "user", text: textOfParts(event.data?.parts as never) };
  if (event.type === "content.completed" && event.data?.kind === "text") return { role: "assistant", text: textOfValue(event.data.value) };
  return null;
}

/**
 * Reads a thread's sessions in order, oldest first, and folds its conversation
 * up to and including the event whose thread key is `eventId` (see
 * `threadKey`; the room's stream route numbers events the same way), with
 * eve's own transcript (user text and completed assistant text). Only a
 * message, said by the person or by the Bot, can be a branch point. Null when
 * the thread has no such message.
 */
export async function foldUntil(
  sessionIds: readonly string[],
  read: (sessionId: string) => AsyncIterable<unknown>,
  eventId: string,
): Promise<BranchPoint | null> {
  // Each session's transcript is its own: a later one's must not overwrite an earlier one's.
  const before: { role: string; text: string }[] = [];
  let offset = 0;
  for (const sessionId of sessionIds) {
    const events: SessionStreamEvent[] = [];
    let lines = 0;
    for await (const value of read(sessionId)) {
      const event = value as Event;
      events.push(value as SessionStreamEvent);
      const position = event.meta?.position;
      if (position === undefined) continue;
      lines = Math.max(lines, position.line + 1);
      if (threadKey(offset, position) !== eventId) continue;
      const point = said(event);
      if (point === null) return null;
      const messages = [...before, ...transcriptOf(events, { maxMessages: BRANCH_MESSAGES }).messages.map((message) => ({ role: message.role as string, text: message.text }))];
      // The transcript keeps a message only once its line is whole; the point itself always belongs.
      const last = messages.at(-1);
      if (point.text !== "" && (last === undefined || last.role !== point.role || last.text !== point.text)) messages.push({ role: point.role, text: point.text });
      return { eventAt: event.meta?.at ?? new Date().toISOString(), text: point.text, messages: messages.slice(-BRANCH_MESSAGES) };
    }
    before.push(...transcriptOf(events, { maxMessages: BRANCH_MESSAGES }).messages.map((message) => ({ role: message.role as string, text: message.text })));
    offset += lines;
  }
  return null;
}
