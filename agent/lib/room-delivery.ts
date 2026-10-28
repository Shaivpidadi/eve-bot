import type { RouteHandlerArgs } from "eve/channels";
import type { SessionAuthContext } from "eve/context";

import ops from "../channels/ops";
import telegram from "../channels/telegram";
import { HQ_ROOM, roomAttributes, TELEGRAM_ROOM } from "./rooms";
import { telegramChatFor } from "./telegram";

/**
 * Starts a turn in a room from a schedule (the watchdog, the standup), as the
 * runtime. A console room is the ops channel's; the Telegram room is the
 * paired chat, so HQ's answer goes to the phone. With no chat paired, the
 * Telegram room's work goes to HQ's desk, where someone will read it.
 *
 * Route handlers in `channels/ops.ts` deliver the same way with their own
 * `from`, which can also move a wedged room to a fresh session.
 */
export async function sendToRoomAs(to: RouteHandlerArgs["to"], appAuth: SessionAuthContext, workspaceId: string, room: string, message: string): Promise<void> {
  if (room === TELEGRAM_ROOM) {
    const chat = await telegramChatFor(workspaceId);
    if (chat !== null) {
      await to(telegram, chat).send(message, { auth: { ...appAuth, attributes: roomAttributes(workspaceId, room) } });
      return;
    }
    room = HQ_ROOM;
  }
  await to(ops, { workspaceId, room }).send(message, { auth: { ...appAuth, attributes: roomAttributes(workspaceId, room) } });
}
