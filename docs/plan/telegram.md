# Plan: Telegram out of the box

Branch `feat/telegram` (from `feat/local-engines`). Tags: `[to-do]`, `[in-progress]`, `[done]`, `[parked]`,
changed in the same commit as the work.

## Goal

Text HQ from your phone. Setting it up takes one thing from the person: a bot token from
@BotFather, pasted into the console (or `npm run setup`). Everything else is automatic, on Vercel and on a
laptop:

- The token is checked (`getMe`), and the bot's @username is shown.
- **On Vercel** (or any `https` address) the webhook is registered with a secret made for it.
- **Locally** there is no public address, so the agent long-polls Telegram (`getUpdates`) and hands each
  update to the same channel route. No tunnel is needed.
- Pairing: the console shows a `t.me/<bot>?start=<code>` link (and a QR code). The chat that opens it becomes
  the owner's chat. Every other chat gets one polite refusal and nothing else.

eve 0.82 already ships `eve/channels/telegram`: signed webhooks, replies split at 4096 characters, inline
buttons for approvals and questions, photos and documents, and proactive sends. Its credentials can be
async functions, so a token saved in the console works without a rebuild.

## What the person gets

- **Talk to HQ.** A Telegram chat is a conversation with HQ (room `desk`), with HQ's tools: hire, assign,
  run jobs, ask about the team. It is its own conversation; the console does not show its transcript.
  Jobs, the feed and the board are shared.
- **Approvals on the phone.** A sign-off or tool approval raised in that chat's work shows as buttons.
- **Alerts.** Needs-you, a job done, a job failed are sent to the paired chat, with the same choices and
  quiet hours as browser notifications.

## Tasks

### T1. The link record `[done]`
- `[done]` The token is sealed in the link record, not a registry setting: the Telegram page owns it.
  `TELEGRAM_BOT_TOKEN` in the environment (from `npm run setup`) connects at the first start.
- `[done]` `agent/lib/telegram.ts`: the link record in the store (`telegram/link.json`: bot username,
  webhook secret, mode `webhook | polling`, pairing code, paired chat and its name), `getMe`, `setWebhook`,
  `deleteWebhook`, and `connectTelegram` / `disconnectTelegram`.
- **Done when:** unit tests cover the mode choice (https and not localhost → webhook; otherwise polling),
  pairing codes, and that the token never appears in a stored record or an error.

### T2. The channel `[done]`
- `[done]` `agent/channels/telegram.ts`: `telegramChannel` with credentials read from the store per request;
  `onMessage` lets through only the paired private chat. `/start <code>` pairs when the code matches; other
  chats get one refusal. Auth: `principalType: "user"`, `authenticator: "telegram"`, attributes
  `{ workspaceId, room: "desk", name }`.
- `[done]` HQ's instructions (`agent/instructions/telegram.ts`): a short "on Telegram" note (plain text, short replies, no Markdown).
- **Done when:** pairing, the paired chat and a stranger are covered by the T8 live check (the channel's
  `onMessage` needs eve's runtime context; the pairing logic under it is unit-tested).

### T3. Local polling `[done]`
- `[done]` `agent/lib/telegram-poll.ts`: one loop per process, never on Vercel. `getUpdates` with a 25 s
  long poll; each update is POSTed to the agent's own `/eve/v1/telegram` with the secret header, so it
  takes exactly the webhook's path. The offset is kept in the link record. It backs off on errors and stops
  when the token is removed or the mode changes.
- `[done]` Started by the worker's tick, by connecting, and by the console's first request, so `npm start`
  and `npm run dev` both poll.
- **Done when:** a test with a fake Bot API sees updates forwarded once, in order, with the offset saved.

### T4. Console `[done]`
- `[done]` Settings → Telegram: paste the token → "Connected as @bot". Then show the pairing link and a QR
  code, then "Paired with <name>". Shows the mode (webhook or polling). Buttons: send a test message,
  disconnect.
- `[done]` Routes on the ops channel (owner only): `GET/POST/DELETE /bot/v1/telegram`,
  `POST /bot/v1/telegram/pair`, `POST /bot/v1/telegram/test`.

### T5. Alerts `[done]`
- `[done]` `notify.ts` `deliver`: also send to the paired chat (the owner's preferences and quiet hours),
  with a link to the console when its address is public.

### T6. Setup `[done]`
- `[done]` `scripts/setup.mjs`: on a standalone server, an optional token step, checked with `getMe`. On Vercel it only
  points to the console: `.env.local` is for development, and a laptop polling the same bot would take it from the
  deployment.

### T7. Docs `[done]`
- `[done]` `docs/configuration.md#telegram`: three steps, how updates arrive, one bot per deployment. README line,
  `.env.example`.

### T8. Live check `[to-do]`
- `[to-do]` Locally with a real bot: connect, pair by QR, ask HQ for a job, approve from a button, get the done alert.
- `[to-do]` On a Vercel preview or production: the webhook is set to the production domain and answers.

## Out of scope for now
- Talking to a Bot directly from Telegram (`@Atlas …`): HQ routes the work already.
- Groups and more than one person per workspace.
- Showing the Telegram conversation in the console.
