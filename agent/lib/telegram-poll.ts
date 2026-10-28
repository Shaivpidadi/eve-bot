import { readDoc } from "./store";
import { readTelegramLink, saveTelegramOffset, telegramApi, telegramToken, TELEGRAM_KEY, TELEGRAM_ROUTE, TelegramError, type TelegramLink } from "./telegram";

/**
 * Telegram without a public address (a laptop, a server on a home network):
 * the agent asks Telegram for updates (`getUpdates`, a 25 s long poll) and
 * posts each one to its own `/eve/v1/telegram` route with the link's secret,
 * exactly as Telegram's webhook would. One loop per process, never on Vercel,
 * where the webhook is used instead.
 *
 * Started by the worker's tick, by connecting, and by the console's requests,
 * so `npm start` and `npm run dev` both poll; it stops by itself when the bot
 * is disconnected or moves to a webhook.
 */
interface Update {
  readonly update_id: number;
}

export interface PollDeps {
  readonly fetch?: typeof fetch;
  /** Where the update is posted: this server's own route. */
  readonly target: () => Promise<string | null>;
  readonly sleep?: (ms: number) => Promise<void>;
}

const LONG_POLL_SECONDS = 25;
let running = false;

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.());

/**
 * One round: asks for what is new and hands each update on, in order, saving
 * the offset after each so a restart never replays or skips one. Returns how
 * many it handed on, or null when there is nothing to poll for.
 */
export async function pollOnce(deps: PollDeps): Promise<number | null> {
  const link = await freshLink();
  if (link === null || link.mode !== "polling") return null;
  const token = await telegramToken(link);
  if (token === null) return null;
  const updates = await telegramApi<Update[]>(
    token,
    "getUpdates",
    { offset: link.offset, timeout: LONG_POLL_SECONDS, allowed_updates: ["message", "callback_query"] },
    { fetch: deps.fetch, signal: AbortSignal.timeout((LONG_POLL_SECONDS + 15) * 1000) },
  );
  const target = await deps.target();
  if (updates.length > 0 && target === null) throw new TelegramError("This server does not know its own address yet.");
  let handed = 0;
  for (const update of updates) {
    const response = await (deps.fetch ?? fetch)(`${target}${TELEGRAM_ROUTE}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": link.secret },
      body: JSON.stringify(update),
      signal: AbortSignal.timeout(30_000),
    });
    // A refused update is dropped, not retried for ever; one the server could not reach is asked for again.
    if (response.status >= 500) throw new TelegramError(`The Telegram route answered ${response.status}.`);
    if (!response.ok) console.warn(`[telegram] update ${update.update_id} was refused (${response.status}).`);
    await saveTelegramOffset(update.update_id + 1);
    handed += 1;
  }
  return handed;
}

/** The link as stored now, not the 5-second cached copy, so a disconnect stops the loop at once. */
async function freshLink(): Promise<TelegramLink | null> {
  return (await readDoc<TelegramLink>(TELEGRAM_KEY).catch(() => null))?.value ?? null;
}

/** Starts the loop when this process should poll and isn't yet. Never throws. */
export function ensureTelegramPolling(deps?: Partial<PollDeps>): void {
  if (running || process.env.VERCEL) return;
  running = true;
  const full: PollDeps = { target: deps?.target ?? (async () => (await import("./self")).selfOrigin()), fetch: deps?.fetch, sleep: deps?.sleep };
  void (async () => {
    let backoff = 0;
    try {
      // Cheap check first: no link, or a webhook, means nothing to do.
      const link = await readTelegramLink();
      if (link === null || link.mode !== "polling") return;
      console.log(`[telegram] polling for @${link.username}`);
      for (;;) {
        try {
          if ((await pollOnce(full)) === null) break;
          backoff = 0;
        } catch (error) {
          backoff = Math.min(60_000, backoff === 0 ? 2_000 : backoff * 2);
          const reason = error instanceof Error ? error.message : String(error);
          // 409: a webhook was set, or another process polls the same bot.
          console.warn(`[telegram] polling paused ${backoff / 1000}s: ${reason}`);
          await (full.sleep ?? wait)(backoff);
        }
      }
      console.log("[telegram] polling stopped");
    } finally {
      running = false;
    }
  })();
}
