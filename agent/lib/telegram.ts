import { randomBytes, timingSafeEqual } from "node:crypto";

import { deleteDoc, readDoc, updateDoc, writeDoc } from "./store";

/**
 * Telegram, connected from the console (see `docs/plan/telegram.md`).
 *
 * One bot per deployment, talking to one person's private chat. The person
 * pastes a token from @BotFather; this checks it, then either registers a
 * webhook (an `https` address Telegram can reach: Vercel, or a server behind
 * one) or leaves the agent to long-poll (a laptop, see `telegram-poll.ts`).
 * The chat that opens the pairing link becomes the owner's; every other chat
 * is refused. The token is sealed in the record and never sent back.
 */
export const TELEGRAM_KEY = "telegram/link.json";
const SEAL_LABEL = "bot-telegram";
export const TELEGRAM_ROUTE = "/eve/v1/telegram";
const API = "https://api.telegram.org";

export type TelegramMode = "webhook" | "polling";

export interface TelegramChatLink {
  readonly id: string;
  readonly name: string;
  readonly at: string;
}

export interface TelegramLink {
  readonly workspaceId: string;
  /** The bot token, sealed. */
  readonly token: string;
  readonly botId: string;
  readonly username: string;
  readonly name: string;
  /** Telegram sends it back with every webhook call (`X-Telegram-Bot-Api-Secret-Token`); the poller sends it too. */
  readonly secret: string;
  readonly mode: TelegramMode;
  readonly webhookUrl: string | null;
  /** Opens the pairing link once; a new one is made after each pairing. */
  readonly pairCode: string;
  readonly chat: TelegramChatLink | null;
  /** The next update the poller asks for. */
  readonly offset: number;
  readonly at: string;
  readonly by: string;
}

/** What the console sees: never the token or the secret. */
export interface TelegramStatus {
  readonly connected: true;
  readonly username: string;
  readonly name: string;
  readonly mode: TelegramMode;
  readonly webhookUrl: string | null;
  readonly chat: { readonly name: string; readonly at: string } | null;
  /** Open it on the phone to pair; null once paired. */
  readonly pairLink: string | null;
}

export class TelegramError extends Error {}

const fresh = (bytes: number) => randomBytes(bytes).toString("base64url");

/** Telegram's own error text, with the token cut out wherever it shows up. */
export function scrubToken(text: string, token: string): string {
  return token.length === 0 ? text : text.split(token).join("<token>");
}

type ApiAnswer<T> = { readonly ok: true; readonly result: T } | { readonly ok: false; readonly description: string };

/** One Bot API call. Throws `TelegramError` with Telegram's reason, never the token. */
export async function telegramApi<T>(token: string, method: string, body?: Record<string, unknown>, options: { readonly fetch?: typeof fetch; readonly signal?: AbortSignal } = {}): Promise<T> {
  const call = options.fetch ?? fetch;
  let answer: ApiAnswer<T>;
  try {
    const response = await call(`${API}/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
      signal: options.signal ?? AbortSignal.timeout(40_000),
    });
    answer = (await response.json().catch(() => ({ ok: false, description: `Telegram answered ${response.status}` }))) as ApiAnswer<T>;
  } catch (error) {
    throw new TelegramError(scrubToken(`Could not reach Telegram: ${error instanceof Error ? error.message : String(error)}`, token));
  }
  if (!answer.ok) throw new TelegramError(scrubToken(answer.description || "Telegram refused the call", token));
  return answer.result;
}

const LOCAL_HOST = /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\]|[^.]+$)|\.local$/i;

/** A webhook needs an `https` address on the internet; anything else polls. */
export function modeFor(origin: string | null): TelegramMode {
  if (origin === null) return "polling";
  try {
    const url = new URL(origin);
    return url.protocol === "https:" && !LOCAL_HOST.test(url.hostname) ? "webhook" : "polling";
  } catch {
    return "polling";
  }
}

const TOKEN_SHAPE = /^\d{5,}:[A-Za-z0-9_-]{30,}$/;

let cached: { readonly link: TelegramLink | null; readonly until: number } | null = null;

/** The link, read at most every 5 seconds per process: the channel reads it on every update. */
export async function readTelegramLink(): Promise<TelegramLink | null> {
  if (cached !== null && cached.until > Date.now()) return cached.link;
  const link = (await readDoc<TelegramLink>(TELEGRAM_KEY).catch(() => null))?.value ?? null;
  cached = { link, until: Date.now() + 5_000 };
  return link;
}

const forget = () => {
  cached = null;
};

export async function telegramToken(link?: TelegramLink | null): Promise<string | null> {
  const current = link === undefined ? await readTelegramLink() : link;
  if (current === null) return null;
  const { unsealWith } = await import("./seal");
  return unsealWith(SEAL_LABEL, current.token);
}

export function statusOf(link: TelegramLink): TelegramStatus {
  return {
    connected: true,
    username: link.username,
    name: link.name,
    mode: link.mode,
    webhookUrl: link.webhookUrl,
    chat: link.chat === null ? null : { name: link.chat.name, at: link.chat.at },
    pairLink: link.chat === null ? `https://t.me/${link.username}?start=${link.pairCode}` : null,
  };
}

interface Me {
  readonly id: number;
  readonly is_bot: boolean;
  readonly first_name: string;
  readonly username?: string;
}

/**
 * Checks the token, then sets the bot up for where this server runs. A token
 * for the bot already connected keeps its paired chat.
 */
export async function connectTelegram(input: {
  readonly workspaceId: string;
  readonly token: string;
  readonly by: string;
  readonly origin: string | null;
  /** A protected Vercel deployment's automation bypass: Telegram can't send headers, so it rides in the webhook's query. */
  readonly bypass?: string;
  readonly fetch?: typeof fetch;
}): Promise<TelegramStatus> {
  const token = input.token.trim();
  if (!TOKEN_SHAPE.test(token)) throw new TelegramError("That is not a bot token. @BotFather gives one like 123456789:AA…");
  const me = await telegramApi<Me>(token, "getMe", undefined, { fetch: input.fetch });
  if (!me.is_bot || me.username === undefined) throw new TelegramError("That token is not a bot's.");

  const before = await readTelegramLink();
  const sameBot = before !== null && before.botId === String(me.id);
  const secret = fresh(32);
  const mode = modeFor(input.origin);
  const webhookUrl = mode === "webhook" ? `${input.origin!.replace(/\/+$/, "")}${TELEGRAM_ROUTE}` : null;
  if (webhookUrl !== null) {
    const url = input.bypass ? `${webhookUrl}?x-vercel-protection-bypass=${encodeURIComponent(input.bypass)}` : webhookUrl;
    await telegramApi(token, "setWebhook", { url, secret_token: secret, allowed_updates: ["message", "callback_query"], drop_pending_updates: !sameBot }, { fetch: input.fetch });
  } else {
    // getUpdates is refused while a webhook is set.
    await telegramApi(token, "deleteWebhook", { drop_pending_updates: !sameBot }, { fetch: input.fetch });
  }
  if (before !== null && !sameBot) await dropWebhook(before, input.fetch);

  const { sealWith } = await import("./seal");
  const link: TelegramLink = {
    workspaceId: input.workspaceId,
    token: await sealWith(SEAL_LABEL, token),
    botId: String(me.id),
    username: me.username,
    name: me.first_name,
    secret,
    mode,
    webhookUrl,
    pairCode: sameBot ? before.pairCode : fresh(12),
    chat: sameBot ? before.chat : null,
    offset: sameBot ? before.offset : 0,
    at: new Date().toISOString(),
    by: input.by,
  };
  await writeDoc(TELEGRAM_KEY, link);
  forget();
  return statusOf(link);
}

async function dropWebhook(link: TelegramLink, call?: typeof fetch): Promise<void> {
  const token = await telegramToken(link);
  if (token !== null) await telegramApi(token, "deleteWebhook", {}, { fetch: call }).catch(() => undefined);
}

export async function disconnectTelegram(call?: typeof fetch): Promise<void> {
  const link = await readTelegramLink();
  if (link === null) return;
  await dropWebhook(link, call);
  await deleteDoc(TELEGRAM_KEY);
  forget();
}

/** Lets another chat pair: the paired one is let go and a new link is made. */
export async function repairTelegram(): Promise<TelegramStatus | null> {
  const next = await updateDoc<TelegramLink>(TELEGRAM_KEY, (link) => (link === null ? null : { ...link, chat: null, pairCode: fresh(12) }));
  forget();
  return next === null ? null : statusOf(next);
}

const sameText = (a: string, b: string) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

/** Whether a request carries this link's secret (Telegram's webhook header, or the poller's). */
export const hasSecret = (link: TelegramLink, given: string | null): boolean => given !== null && sameText(link.secret, given);

/**
 * Pairs the chat that sent `/start <code>`, when the code is this link's and
 * no chat is paired yet. Returns the paired chat, or null.
 */
export async function pairTelegramChat(code: string, chat: { readonly id: string; readonly name: string }): Promise<TelegramChatLink | null> {
  let paired = null as TelegramChatLink | null;
  await updateDoc<TelegramLink>(TELEGRAM_KEY, (link) => {
    if (link === null || link.chat !== null || !sameText(link.pairCode, code)) return null;
    paired = { id: chat.id, name: chat.name, at: new Date().toISOString() };
    return { ...link, chat: paired, pairCode: fresh(12) };
  });
  forget();
  return paired;
}

export async function saveTelegramOffset(offset: number): Promise<void> {
  await updateDoc<TelegramLink>(TELEGRAM_KEY, (link) => (link === null || link.offset >= offset ? null : { ...link, offset }));
  forget();
}

/**
 * Where work for the Telegram room goes: the paired chat, when this
 * workspace's bot has one. Null sends it to HQ's desk instead.
 */
export async function telegramChatFor(workspaceId: string): Promise<{ readonly chatId: string } | null> {
  const link = await readTelegramLink();
  return link === null || link.chat === null || link.workspaceId !== workspaceId ? null : { chatId: link.chat.id };
}

/**
 * Sends the paired chat a message outside a conversation (an alert, the
 * console's test). Plain text; false when nothing is paired or Telegram refused.
 */
export async function sendToPairedChat(text: string, call?: typeof fetch): Promise<boolean> {
  const link = await readTelegramLink();
  if (link === null || link.chat === null) return false;
  const token = await telegramToken(link);
  if (token === null) return false;
  try {
    await telegramApi(token, "sendMessage", { chat_id: link.chat.id, text: text.slice(0, 4096), link_preview_options: { is_disabled: true } }, { fetch: call });
    return true;
  } catch (error) {
    console.warn("[telegram] could not send:", error instanceof Error ? error.message : String(error));
    return false;
  }
}

/**
 * Where Telegram should send updates: the address pinned in Settings, else,
 * on Vercel's production, the project's production domain (a deployment's own
 * URL changes with each deploy), else the address the console was reached by.
 */
export async function telegramOrigin(env: Readonly<Record<string, string | undefined>> = process.env): Promise<string | null> {
  const { liveEnv } = await import("./settings/store");
  const { publicOrigin } = await import("./self");
  if (liveEnv().BOT_PUBLIC_URL?.trim()) return publicOrigin();
  const production = env.VERCEL_ENV === "production" ? env.VERCEL_PROJECT_PRODUCTION_URL?.trim() : undefined;
  return production ? `https://${production}` : publicOrigin();
}

/** The connect call's options for this deployment: where it is reached, and Vercel's bypass when it has one. */
export async function connectOptions(env: Readonly<Record<string, string | undefined>> = process.env): Promise<{ readonly origin: string | null; readonly bypass?: string }> {
  const bypass = env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim();
  return { origin: await telegramOrigin(env), ...(bypass ? { bypass } : {}) };
}

/**
 * A token in the environment (`TELEGRAM_BOT_TOKEN`, as `npm run setup` writes
 * it) connects on its own the first time, so the console only has to pair.
 */
export async function connectFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): Promise<TelegramLink | null> {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  const link = await readTelegramLink();
  if (link !== null || token === undefined || token === "") return link;
  try {
    await connectTelegram({ workspaceId: env.BOT_DEFAULT_WORKSPACE ?? "default", token, by: "environment", ...(await connectOptions(env)) });
  } catch (error) {
    console.warn("[telegram] TELEGRAM_BOT_TOKEN did not connect:", error instanceof Error ? error.message : String(error));
  }
  return readTelegramLink();
}
