import { readDoc, updateDoc } from "./store";

/**
 * What the roster needs to know about a room without replaying its stream: the
 * last line said, whether a turn is running, and what is waiting on a person.
 * Maintained by `hooks/audit.ts` from the durable event stream.
 */
export interface PendingInput {
  readonly requestId: string;
  readonly kind: string;
  readonly prompt: string;
  readonly at: string;
}

export interface AnsweredInput {
  readonly requestId: string;
  readonly outcome: "approved" | "denied" | "answered";
  readonly optionId: string | null;
  readonly at: string;
}

export interface RoomState {
  readonly workspaceId: string;
  readonly room: string;
  preview: { text: string; from: "you" | "bot"; at: string } | null;
  pending: PendingInput[];
  /**
   * Requests a person answered from the console. A request raised inside
   * background work (a job's sign-off, a Bot asking to be taken over) never
   * reports its own resolution on the room's stream, so the answer is kept here.
   */
  answered?: AnsweredInput[];
  /** A turn is running in this room right now. */
  active: boolean;
  /**
   * The session that last spoke in this room. Once a session ends, the room's
   * address no longer resolves to it, and this is how its thread still reads back.
   */
  sessionId?: string | null;
  /** How many times the room was started over; part of its session address (see `rooms.ts`). */
  generation?: number;
  /** When the room was last started over: the thread shows nothing recorded before this. */
  clearedAt?: string | null;
  /** When a message was last handed to the room's session by the console or the API. */
  sentAt?: string | null;
  /** When the room's session last started a turn. Older than `sentAt` for too long means the session is wedged. */
  turnAt?: string | null;
  /** How many times the room's session was restarted because it stopped answering. */
  restarts?: number;
  updatedAt: string;
}

/**
 * How long a delivered message may wait before the thread counts as wedged.
 * A turn normally starts within a second or two; a minute leaves room for a
 * cold Vercel function and a slow store, and is still short enough that a
 * person has not given up on the reply.
 */
export const WEDGED_AFTER_MS = 45_000;

/**
 * eve 0.58 has a failure where a session accepts a message and never starts a
 * turn: after the dev runtime reloads, or after certain task interactions. It
 * emits nothing, so the only sign is a delivery with no turn behind it. That
 * is what this reads: the last message went in, no turn has started since,
 * and long enough has passed that one would have.
 */
export function isWedged(state: Pick<RoomState, "sentAt" | "turnAt"> | null, now: number = Date.now(), graceMs: number = WEDGED_AFTER_MS): boolean {
  const sentAt = state?.sentAt ?? null;
  if (sentAt === null) return false;
  const sent = Date.parse(sentAt);
  if (!Number.isFinite(sent) || now - sent < graceMs) return false;
  const turnAt = state?.turnAt ?? null;
  return turnAt === null || Date.parse(turnAt) < sent;
}

const PREVIEW_CHARS = 280;
const MAX_PENDING = 20;
const MAX_ANSWERED = 50;

const key = (workspaceId: string, room: string) => `rooms/${workspaceId}/${room}.json`;

export async function getRoomState(workspaceId: string, room: string): Promise<RoomState | null> {
  return (await readDoc<RoomState>(key(workspaceId, room)))?.value ?? null;
}

async function updateRoom(
  workspaceId: string,
  room: string,
  patch: (state: RoomState) => RoomState,
): Promise<void> {
  await updateDoc<RoomState>(key(workspaceId, room), (current) => ({
    ...patch(
      current ?? { workspaceId, room, preview: null, pending: [], active: false, updatedAt: "" },
    ),
    updatedAt: new Date().toISOString(),
  }));
}

/** Which generation of the room's address is current. Zero until it is first started over. */
export async function roomGeneration(workspaceId: string, room: string): Promise<number> {
  return (await getRoomState(workspaceId, room))?.generation ?? 0;
}

/**
 * A room started over: no session, no thread to read back, nothing waiting, and
 * a new generation, so the next message opens a fresh session at a new address.
 */
export async function resetRoom(workspaceId: string, room: string): Promise<number> {
  let generation = 1;
  await updateDoc<RoomState>(key(workspaceId, room), (current) => {
    generation = (current?.generation ?? 0) + 1;
    return {
      workspaceId,
      room,
      preview: null,
      pending: [],
      answered: [],
      active: false,
      sessionId: null,
      generation,
      clearedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  });
  return generation;
}

export function notePreview(
  workspaceId: string,
  room: string,
  from: "you" | "bot",
  text: string,
  at: string,
): Promise<void> {
  const trimmed = text.replaceAll(/\s+/g, " ").trim().slice(0, PREVIEW_CHARS);
  if (trimmed === "") return Promise.resolve();
  return updateRoom(workspaceId, room, (state) =>
    state.preview !== null && state.preview.at > at
      ? state
      : { ...state, preview: { text: trimmed, from, at } },
  );
}

export function noteActive(workspaceId: string, room: string, active: boolean): Promise<void> {
  return updateRoom(workspaceId, room, (state) => ({ ...state, active }));
}

/** A message went to the room's session; the watchdog now expects a turn. */
export function noteSent(workspaceId: string, room: string, at: string = new Date().toISOString()): Promise<void> {
  return updateRoom(workspaceId, room, (state) => ({ ...state, sentAt: at }));
}

/** A turn started: the room is busy, and whatever was sent has been picked up. */
export function noteTurnStarted(workspaceId: string, room: string, at: string = new Date().toISOString()): Promise<void> {
  return updateRoom(workspaceId, room, (state) => ({ ...state, active: true, turnAt: at }));
}

/**
 * Moves the room to a fresh session without clearing the thread: the next
 * message opens a new session under a new generation, while what the person
 * saw stays in the console. For a session that stopped answering.
 */
export async function restartRoom(workspaceId: string, room: string): Promise<number> {
  let generation = 1;
  await updateDoc<RoomState>(key(workspaceId, room), (current) => {
    const state = current ?? { workspaceId, room, preview: null, pending: [], active: false, updatedAt: "" };
    generation = (state.generation ?? 0) + 1;
    return {
      ...state,
      pending: [],
      active: false,
      sessionId: null,
      generation,
      sentAt: null,
      turnAt: null,
      restarts: (state.restarts ?? 0) + 1,
      updatedAt: new Date().toISOString(),
    };
  });
  return generation;
}

export function noteSession(workspaceId: string, room: string, sessionId: string): Promise<void> {
  return updateRoom(workspaceId, room, (state) =>
    state.sessionId === sessionId ? state : { ...state, sessionId },
  );
}

export function notePending(
  workspaceId: string,
  room: string,
  requests: readonly PendingInput[],
): Promise<void> {
  return updateRoom(workspaceId, room, (state) => {
    const known = new Set(state.pending.map((entry) => entry.requestId));
    const added = requests.filter((entry) => !known.has(entry.requestId));
    return { ...state, pending: [...state.pending, ...added].slice(-MAX_PENDING) };
  });
}

export function noteAnswered(
  workspaceId: string,
  room: string,
  answers: readonly { readonly requestId: string; readonly optionId?: string }[],
): Promise<void> {
  const at = new Date().toISOString();
  const added = answers.map(
    ({ requestId, optionId }): AnsweredInput => ({
      requestId,
      optionId: optionId ?? null,
      at,
      // eve's approval options are "approve" and "cancel".
      outcome:
        optionId === "approve"
          ? "approved"
          : optionId === "cancel" || optionId === "deny" || optionId === "reject"
            ? "denied"
            : "answered",
    }),
  );
  const ids = new Set(added.map((entry) => entry.requestId));
  return updateRoom(workspaceId, room, (state) => ({
    ...state,
    pending: state.pending.filter((entry) => !ids.has(entry.requestId)),
    answered: [...(state.answered ?? []).filter((entry) => !ids.has(entry.requestId)), ...added].slice(-MAX_ANSWERED),
  }));
}

export function noteResolved(
  workspaceId: string,
  room: string,
  requestIds: readonly string[],
): Promise<void> {
  const resolved = new Set(requestIds);
  return updateRoom(workspaceId, room, (state) => ({
    ...state,
    pending: state.pending.filter((entry) => !resolved.has(entry.requestId)),
  }));
}
