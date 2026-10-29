import { findBot, getBot, HQ_BOT_ID } from "./bots";
import { newId } from "./ids";
import { botIdForRoom, HQ_ROOM, roomForBot } from "./rooms";
import { deliverOutbox, enqueue } from "./outbox";
import { flushOutboxSoon } from "./self";
import { readDoc, updateDoc, writeDoc } from "./store";

/**
 * Teammates talking to each other.
 *
 * A Bot (or HQ) leaves a note for a teammate with `message_teammate`. The note
 * goes into the outbox (see `outbox.ts`) and is delivered into the teammate's
 * own thread as a turn of its own, at once when the server can call itself,
 * else on the console's board poll, a message sent from the console, or the
 * watchdog. The teammate reads
 * it in its own voice and context, and answers the same way, so a question
 * and its answer appear in both threads.
 *
 * Tools cannot open a session in another thread themselves, which is why the
 * outbox exists. Notes between the same two teammates are rate-limited, so a
 * pair that keeps answering each other cannot run up the bill.
 */
export interface TeamNote {
  readonly id: string;
  readonly workspaceId: string;
  readonly from: { readonly name: string; readonly room: string };
  readonly to: { readonly name: string; readonly room: string };
  readonly text: string;
  readonly at: string;
}

export const MAX_NOTE_CHARS = 4000;
/** Notes one teammate may send another inside the window. */
export const NOTES_PER_WINDOW = 6;
export const NOTE_WINDOW_MS = 10 * 60_000;
const logKey = (workspaceId: string, from: string, to: string) => `mail-log/${workspaceId}/${from}__${to}.json`;

/** How a note reads when it arrives; the console shows it as the sender's bubble (see `room-store.ts`). */
export function noteMessage(note: Pick<TeamNote, "id" | "from" | "text">): string {
  return [
    `Teammate message from ${note.from.name} [${note.id}]:`,
    note.text,
    "",
    `— If ${note.from.name} asked you something, answer with message_teammate to "${note.from.name}". If it is work for you, take it on as your own job. A note that needs nothing back needs no reply.`,
  ].join("\n");
}

export const TEAMMATE_MESSAGE = /^Teammate message from (.+?) \[(mail_[a-z0-9]+)\]:\n/;

/** Where a teammate is addressed: "HQ", a Bot's name, or its id. */
export async function teammateRoom(workspaceId: string, reference: string): Promise<{ name: string; room: string; paused: boolean } | null> {
  const trimmed = reference.trim().replace(/^@/, "");
  if (trimmed.toLowerCase() === "hq" || trimmed === HQ_BOT_ID) return { name: "HQ", room: HQ_ROOM, paused: false };
  const bot = await findBot(workspaceId, trimmed);
  return bot === null ? null : { name: bot.name, room: roomForBot(bot.id), paused: bot.status !== "active" };
}

/** Who is speaking in a room: HQ on its desk, or the Bot whose thread it is. */
export async function speakerFor(workspaceId: string, botId: string | null): Promise<string> {
  if (botId === null) return "HQ";
  return (await getBot(workspaceId, botId))?.name ?? "A teammate";
}

/**
 * HQ talks from its desk and from the Telegram chat. A Bot answering "HQ"
 * answers where HQ last wrote to it from, for a day, so a question asked from
 * the phone is answered on the phone; otherwise on the desk.
 */
const HQ_ASKED_MS = 24 * 60 * 60_000;
const hqAskedKey = (workspaceId: string, botRoom: string) => `mail-hq/${workspaceId}/${botRoom}.json`;

export async function hqRoomFor(workspaceId: string, botRoom: string, now = Date.now()): Promise<string> {
  const asked = (await readDoc<{ room: string; at: string }>(hqAskedKey(workspaceId, botRoom)).catch(() => null))?.value;
  return asked !== undefined && now - Date.parse(asked.at) < HQ_ASKED_MS ? asked.room : HQ_ROOM;
}

export async function postNote(input: {
  readonly workspaceId: string;
  readonly from: TeamNote["from"];
  readonly to: TeamNote["to"];
  readonly text: string;
  readonly now?: number;
}): Promise<{ ok: true; note: TeamNote } | { ok: false; reason: string }> {
  const now = input.now ?? Date.now();
  let allowed = true;
  await updateDoc<{ at: string[] }>(logKey(input.workspaceId, input.from.room, input.to.room), (current) => {
    const recent = (current?.at ?? []).filter((at) => now - Date.parse(at) < NOTE_WINDOW_MS);
    allowed = recent.length < NOTES_PER_WINDOW;
    return allowed ? { at: [...recent, new Date(now).toISOString()] } : { at: recent };
  });
  if (!allowed) {
    return { ok: false, reason: `You have sent ${input.to.name} ${NOTES_PER_WINDOW} messages in the last few minutes. Wait for their answer, or tell the operator instead.` };
  }
  const note: TeamNote = {
    id: newId("mail"),
    workspaceId: input.workspaceId,
    from: input.from,
    to: input.to,
    text: input.text.slice(0, MAX_NOTE_CHARS),
    at: new Date(now).toISOString(),
  };
  // HQ (from either of its rooms) writing to a Bot: the Bot's answer comes back to that room.
  if (botIdForRoom(note.from.room) === null && botIdForRoom(note.to.room) !== null) {
    await writeDoc(hqAskedKey(note.workspaceId, note.to.room), { room: note.from.room, at: note.at }).catch(() => undefined);
  }
  await enqueue({ workspaceId: note.workspaceId, room: note.to.room, message: noteMessage(note), id: note.id });
  await flushOutboxSoon();
  return { ok: true, note };
}

/** Delivers every waiting note (and anything else in the outbox). */
export const deliverNotes = deliverOutbox;
