import { botIdForRoom, HQ_ROOM, isRoomName, TELEGRAM_ROOM } from "./rooms";

/**
 * Where and when the daily standup lands.
 *
 * The console's board lists HQ's desk and one room per Bot, nothing else, so a
 * standup posted anywhere else — and any follow-up question it parks on — is
 * written into a room nobody can open. The standup therefore goes to the desk,
 * and an override is honoured only when it names a room the board shows: the
 * desk itself, or a Bot's room (`bot-<id>`). Anything else falls back to the
 * desk rather than vanishing.
 *
 * Time is a cron expression and is always UTC: eve turns each schedule into a
 * Vercel Cron Job, Vercel evaluates every expression in UTC, and the expression
 * is fixed when the app is built. There is no timezone to set; pick the UTC
 * hour that matches the team's morning (13:00 UTC is 09:00 in New York in
 * summer, 08:00 in winter). Vercel Hobby runs crons at most once a day, which
 * a daily standup is.
 */
export const STANDUP_DEFAULT_CRON = "0 13 * * 1-5";

type Env = Readonly<Record<string, string | undefined>>;

/** The standup's cron, in UTC. `BOT_STANDUP_CRON` overrides it at build time. */
export function standupCron(env: Env = process.env): string {
  const named = env.BOT_STANDUP_CRON?.trim();
  return named === undefined || named === "" ? STANDUP_DEFAULT_CRON : named;
}

/** Whether the console's board lists this room, so a person can read what lands in it. */
export const isBoardRoom = (room: string): boolean =>
  room === HQ_ROOM || (isRoomName(room) && (botIdForRoom(room) ?? "") !== "");

/** Where the standup may go: a room the board lists, or the paired Telegram chat (HQ's desk while none is paired). */
const isStandupRoom = (room: string): boolean => isBoardRoom(room) || room === TELEGRAM_ROOM;

/**
 * The room the standup posts to: `BOT_STANDUP_ROOM` when it names a room the
 * board lists, HQ's desk otherwise. A Bot's room is only checked by shape here;
 * the schedule confirms the Bot still exists before it posts there.
 */
export function standupRoom(env: Env = process.env): string {
  const named = env.BOT_STANDUP_ROOM?.trim();
  if (named === undefined || named === "") return HQ_ROOM;
  if (isStandupRoom(named)) return named;
  console.warn(`[bot] BOT_STANDUP_ROOM="${named}" is not a room the console shows; posting the standup to ${HQ_ROOM}.`);
  return HQ_ROOM;
}
