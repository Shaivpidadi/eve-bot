import { transcriptReducer } from "eve/client";

/** The newest messages a branched session starts from. */
export const BRANCH_MESSAGES = 40;

interface StreamEvent {
  readonly type?: string;
  readonly meta?: { readonly id?: string; readonly at?: string };
  readonly data?: { readonly message?: unknown };
}

/** The point a person went back to, and the conversation up to and including it. */
export interface BranchPoint {
  readonly eventAt: string;
  readonly text: string;
  readonly messages: readonly { readonly role: string; readonly text: string }[];
}

/**
 * Reads a thread's sessions in order, oldest first, and folds its conversation
 * up to and including the message whose event id is `eventId`, with eve's own
 * transcript reducer (user text and completed assistant text). Only a message,
 * said by the person or by the Bot, can be a branch point. Null when the thread
 * has no such message.
 */
export async function foldUntil(
  sessionIds: readonly string[],
  read: (sessionId: string) => AsyncIterable<unknown>,
  eventId: string,
): Promise<BranchPoint | null> {
  // One reducer per session: eve numbers a session's messages from zero, so a
  // single reducer across sessions would let a later one overwrite an earlier.
  const before: { role: string; text: string }[] = [];
  for (const sessionId of sessionIds) {
    const reducer = transcriptReducer({ maxMessages: BRANCH_MESSAGES });
    let transcript = reducer.initial();
    for await (const value of read(sessionId)) {
      transcript = reducer.reduce(transcript, value as never);
      const event = value as StreamEvent;
      if (event.meta?.id !== eventId) continue;
      if (event.type !== "message.received" && event.type !== "message.completed") return null;
      const text = typeof event.data?.message === "string" ? event.data.message : "";
      const role = event.type === "message.received" ? "user" : "assistant";
      const messages = [...before, ...transcript.messages.map((message) => ({ role: message.role as string, text: message.text }))];
      // The reducer may settle a message only when its turn does; the point itself always belongs.
      const last = messages.at(-1);
      if (text !== "" && (last === undefined || last.role !== role || last.text !== text)) messages.push({ role, text });
      return { eventAt: event.meta.at ?? new Date().toISOString(), text, messages: messages.slice(-BRANCH_MESSAGES) };
    }
    before.push(...transcript.messages.map((message) => ({ role: message.role as string, text: message.text })));
  }
  return null;
}

/** A ReadableStream as an async iterable that stops reading when the loop ends early. */
export async function* eventsOf(stream: ReadableStream<unknown>): AsyncIterable<unknown> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
