/**
 * Where conversations live. HQ's desk is one room and every bot has its own, so
 * messaging a bot resumes that bot's thread the next day instead of a new chat.
 */
export const HQ_ROOM = "desk";

const BOT_ROOM_PREFIX = "bot-";
const ROOM_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

export const roomForBot = (botId: string): string => `${BOT_ROOM_PREFIX}${botId}`;

export function botIdForRoom(room: string): string | null {
  return room.startsWith(BOT_ROOM_PREFIX) ? room.slice(BOT_ROOM_PREFIX.length) : null;
}

export const isRoomName = (value: string): boolean => ROOM_NAME.test(value);

/**
 * Rooms are addressed per workspace. Without the prefix, every workspace's
 * `desk` would resolve to one shared durable session.
 */
export const roomAddress = (workspaceId: string, room: string): string => `${workspaceId}:${room}`;

/** The dispatcher's wake-up line, written by `schedules/tick.ts`. */
export const DUE_JOB_MESSAGE = /^Job (job_[a-z0-9]+) is due: "(.*)"\./;

/** How a routine's run opens the report it posts after each cycle (see `run_job`). */
export const ROUTINE_REPORT_PREFIX = "Routine report:";

/** Messages the runtime wrote into a room rather than a person. */
export function isSystemMessage(text: string): boolean {
  return (
    DUE_JOB_MESSAGE.test(text) ||
    text.startsWith(ROUTINE_REPORT_PREFIX) ||
    text.startsWith("Write the daily standup") ||
    // eve's background-task notifications: completed, failed, update, authorization.
    /^Background task \S+ /.test(text)
  );
}

/** Auth attributes a turn in this room carries; tools read them, never model input. */
export function roomAttributes(workspaceId: string, room: string): Record<string, string> {
  const botId = botIdForRoom(room);
  return botId === null ? { workspaceId, room } : { workspaceId, room, botId };
}
