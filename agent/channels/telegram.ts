import { randomBytes } from "node:crypto";

import { telegramChannel, type TelegramContext } from "eve/channels/telegram";

import { HQ_ROOM } from "../lib/rooms";
import { pairTelegramChat, readTelegramLink, telegramToken } from "../lib/telegram";

/**
 * HQ on Telegram (see `docs/plan/telegram.md`). The bot is connected from the
 * console, which keeps its token and webhook secret in the store, so both are
 * read per update and a new token needs no rebuild. Only the paired private
 * chat reaches HQ; it pairs by opening the console's link (`/start <code>`).
 * On a laptop the poller (`lib/telegram-poll.ts`) posts updates here with the
 * same secret, so both paths are one.
 */

/** Before a bot is connected nothing can match it: an empty secret would read as "none set". */
const UNSET = randomBytes(32).toString("base64url");

const STRANGER = "This is a private assistant. Its owner pairs a chat from the console: Settings → Telegram.";

const nameOf = (from: { readonly firstName?: string; readonly lastName?: string; readonly username?: string } | undefined): string =>
  [from?.firstName, from?.lastName].filter(Boolean).join(" ") || (from?.username === undefined ? "Telegram" : `@${from.username}`);

const say = (ctx: TelegramContext, text: string) => ctx.telegram.post(text).catch(() => undefined);

export default telegramChannel({
  credentials: {
    botToken: async () => (await telegramToken()) ?? "",
    webhookSecretToken: async () => (await readTelegramLink())?.secret ?? UNSET,
  },
  uploadPolicy: { allowedMediaTypes: ["image/*", "application/pdf", "text/*"], maxBytes: 10 * 1024 * 1024 },
  async onMessage(ctx, message) {
    const link = await readTelegramLink();
    if (link === null || message.chat.type !== "private" || message.from === undefined || message.from.isBot) return null;
    const text = (message.text || message.caption).trim();
    const start = /^\/start(?:@\w+)?(?:\s+(\S+))?$/.exec(text);

    if (link.chat === null) {
      const paired = start?.[1] === undefined ? null : await pairTelegramChat(start[1], { id: message.chat.id, name: nameOf(message.from) });
      await say(ctx, paired === null ? STRANGER : `Paired. This chat now talks to HQ, your chief of staff. Ask for anything, or "what is the team doing?"`);
      return null;
    }
    if (link.chat.id !== message.chat.id) {
      await say(ctx, STRANGER);
      return null;
    }
    if (start !== null) {
      await say(ctx, `You're talking to HQ. Ask for anything, or "what is the team doing?"`);
      return null;
    }

    await ctx.telegram.startTyping();
    return {
      auth: {
        principalType: "user",
        principalId: `telegram:${message.from.id}`,
        authenticator: "telegram",
        attributes: { workspaceId: link.workspaceId, room: HQ_ROOM, name: nameOf(message.from), channel: "telegram" },
      },
      title: "Telegram",
    };
  },
});
