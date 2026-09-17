# EVE BOT

A team of always-on AI teammates. Each one has its own computer, works inside
the apps you already use, and keeps going after you close the laptop, coming
back only when something needs your approval.

```
you ──▶ HQ ──assign──▶ job queue ──dispatch──▶ teammate ──▶ browser + shell + files
         │                  ▲                      │
         │                  └── waits until due ────┤
         └──◀ result, or an approval you must sign ─┘
```

Built on [eve](https://vercel.com/eve) and Next.js. Alpha. MIT.

## Pick where it runs

Bot runs in one of two places. Same code, different plumbing.

| | Vercel | Standalone |
| --- | --- | --- |
| Setup | one click | `npm run setup` |
| The team's computer | Vercel Sandbox | Docker on your machine |
| Models | AI Gateway, with Jev routing | Ollama, LM Studio, OpenRouter, any OpenAI-compatible API |
| Storage and memory | Vercel Blob | disk |
| Schedules | Vercel Cron | the server's own cron |
| Web search | eve's, through AI Gateway | your SearXNG, or Brave, Tavily, Exa |
| Costs | billed by Vercel | whatever your endpoint charges; caps still hold |

### Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FShaivpidadi%2Feve-bot&project-name=eve-bot&repository-name=eve-bot&env=BOT_CONSOLE_TOKEN&envDescription=A%20long%20random%20password%20you%20sign%20in%20to%20the%20console%20with&envLink=https%3A%2F%2Fgithub.com%2FShaivpidadi%2Feve-bot%23vercel&stores=%5B%7B%22type%22%3A%22blob%22%2C%22access%22%3A%22private%22%7D%5D)

The button copies this repository to your GitHub, creates the project, connects
a private Blob store, and deploys. It asks for one thing: `BOT_CONSOLE_TOKEN`,
the password you sign in with (`openssl rand -base64 32` makes a good one).
Then open `/bot` on your deployment.

You can put the deployment behind your Vercel login instead: **Settings →
Deployment Protection → Vercel Authentication → All Deployments**. Standard
Protection is not enough; it leaves the production address public.

Hobby plans work. On Pro, `BOT_TICK_CRON="* * * * *"` runs the watchdog every
minute instead of daily.

To develop against it locally:

```bash
npm install
npx vercel link && npx vercel env pull   # Sandbox and Gateway credentials
npm run dev                              # http://localhost:3000/bot
```

### Standalone

Requires Node 24, Docker (Desktop, OrbStack, Colima, or a Docker host), and a
model endpoint.

```bash
npm install
npm run setup                 # pick Standalone; writes .env
npm run build && npm start    # http://localhost:3000/bot
```

`npm start` runs the agent and the console as one service, provisions the
computer's Docker image on first run (a few minutes, with Chrome and a small
desktop), and stops the computer when it stops. Keep `.data/`,
`.eve/.workflow-data/`, and the `bot-computer` Docker volume on storage that
survives a restart.

As containers, with a SearXNG for search and an optional Ollama:

```bash
npm run setup
docker compose up -d --build                     # add --profile ollama for a model server
```

In `.env`, address other services by name, not `localhost`: a model server on
the machine itself is `http://host.docker.internal:11434/v1`, the profile's
Ollama is `http://ollama:11434/v1`.

Pick a model that handles tool calls well; the Bots do everything through
tools. Jev is off here on its own, since it lives on AI Gateway.

## What you get

- **HQ.** The teammate you message. It writes a brief with success criteria,
  hands the job to the right Bot, and reports back. It does no work itself.
- **Bots.** Each has a name, a job, a persona, a playbook it learns, and its
  own thread. Every workspace starts with Atlas, a generalist. Retire a Bot and
  it stays gone; if a job ever finds nobody on the team, Atlas rejoins on his
  own.
- **One computer, kept.** A persistent Linux machine with one Chrome, a
  terminal, and files, shared by the whole team. Sign-ins carry across Bots.
  It is backed up while Bots work and restored if it is ever replaced.
- **Watch and take over.** The screen sits in every thread. When a Bot hits a
  sign-in, code, or CAPTCHA, it asks you; you do the step in its live browser
  and hand back. Passwords go into the page, never through chat.
- **Durable jobs.** A run survives restarts and redeploys, waits for its start
  time with no compute, renews a lease so a dead run is noticed, and can park
  a day for your sign-off. A daily watchdog re-dispatches anything stranded.
- **Approvals.** Sending email, retiring a Bot, and anything a plugin marks
  sensitive stop for a person first.
- **Memory.** Per-person, per-workspace, and per-craft memory, plus each Bot's
  playbook. Open **Memory** in the console to see and edit it.
- **Plugins.** Connect an MCP server once and every Bot can use it.

## Jev

Bot builds explicit state everywhere, so its small decisions go to
[Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev), a
decision model: structured state in, a typed choice with a probability out, in
under a second, for a fraction of a cent. One switch, `BOT_JEV`, on by default.

| Decision | Jev picks | Fallback |
| --- | --- | --- |
| HQ's model, each turn | the team's `standard` or `deep` model | `standard`, or `BOT_HQ_MODEL` |
| Which Bot takes a job | a fitting specialist, else the generalist | the generalist |
| A job's effort | `quick`, `standard`, or `deep`, which picks the Bot's model | HQ's level |
| The next browser step | with `page_pilot`, which element to click or type into, or stop | the Bot clicks itself |

The pilot never invents text, never presses anything consequential (send, pay,
delete, publish, sign out), and stops at any sign-in. The Bot does those steps.
Jev is in early access on AI Gateway; without access, set `BOT_JEV=off`.

## The console

`/bot`: your Bots on the left, the selected thread in the middle, the team's
screen and the Bot's routines on the right. Right-click a Bot, or use the **⋯**
on hover, for its menu: pin, move to a section, mark unread, clear chat,
rename, edit profile, duplicate, copy conversation id, hide, delete. Pins,
sections, and hiding are saved on the Bot; unread is yours alone.

Opening the console from another device over plain http puts the browser in
an insecure context, and the live screen will not connect. Use
`npm run dev:https`, or on a standalone server set `BOT_COMPUTER_LOCAL_BIND=0.0.0.0`
and serve over http, or put the gateway behind TLS.

## HTTP

Send `Authorization: Bearer <console token>`. Rooms are `desk` for HQ and
`bot-<botId>` for a Bot.

```bash
curl -X POST localhost:3000/bot/v1/rooms/desk/messages -H 'content-type: application/json' -d '{"message":"Who is on the team?"}'
curl -N 'localhost:3000/bot/v1/rooms/desk/stream?startIndex=0'          # NDJSON, live
curl -X POST localhost:3000/bot/v1/rooms/desk/respond -H 'content-type: application/json' -d '{"responses":[{"requestId":"<id>","optionId":"approve"}]}'
curl -X POST localhost:3000/bot/v1/rooms/desk/reset                       # start the thread over
curl localhost:3000/bot/v1/state                                          # roster, presence, feed
curl -X POST localhost:3000/bot/v1/bots -H 'content-type: application/json' -d '{"name":"Ava","role":"Inbound sales follow-up","persona":"Warm and brief."}'
curl -X PATCH localhost:3000/bot/v1/bots/<id> -H 'content-type: application/json' -d '{"status":"paused","pinned":true,"section":"Sales"}'
curl -X POST localhost:3000/bot/v1/bots/<id>/duplicate
curl -X DELETE localhost:3000/bot/v1/bots/<id>
```

## Configuration

Everything is optional except a model credential. `.env.example` documents all
of it; these are the ones that matter.

| Variable | Does |
| --- | --- |
| `AI_GATEWAY_API_KEY` | model access on Vercel (or link the project and use OIDC) |
| `BOT_MODEL_BASE_URL` / `BOT_MODEL` / `BOT_MODEL_API_KEY` | your own OpenAI-compatible endpoint and the model used everywhere on it |
| `BOT_MODEL_QUICK` / `BOT_MODEL_STANDARD` / `BOT_MODEL_DEEP` | the model at each effort level; HQ routes between the last two |
| `BOT_HQ_MODEL` | pin HQ to one model |
| `BOT_JEV` / `BOT_JEV_MODEL` | Jev on (default) or off; the decision model id |
| `BOT_COMPUTER` | `vercel` (default) or `local` |
| `BOT_COMPUTER_LOCAL_BIND` | where a local computer's live view is published; `127.0.0.1` by default |
| `BOT_SEARCH_PROVIDER` / `BOT_SEARCH_URL` / `BOT_SEARCH_API_KEY` | web search on your own endpoint: `searxng`, `brave`, `tavily`, `exa` |
| `BOT_MODEL_PRICES` | `model=in/out` USD per million tokens, so spend caps hold off Gateway; OpenRouter is read automatically |
| `BOT_HQ_COST_LIMIT_USD` / `BOT_JOB_COST_LIMIT_USD` | per-session spend caps (`10` / `5`) |
| `BOT_CONSOLE_TOKEN` / `BOT_CONSOLE_TOKENS` | console passwords, each bound to a workspace |
| `BOT_TICK_CRON` | the watchdog's schedule; daily by default |
| `BOT_SANDBOX_ALLOW_DOMAINS` / `BOT_BROWSER_ALLOWED_DOMAINS` | fence the computer and the browser |
| `BOT_EMAIL_WEBHOOK` | where approved email goes; unset returns drafts |

## Development

```bash
npm run dev          # console and agent together
npm run agent:dev    # the agent alone, with eve's terminal UI
npm test             # vitest over tests/: store, models, pricing, search, access, handovers
npm run typecheck && npm run build
```

Schedules do not fire under `npm run dev`; trigger the watchdog with
`curl -X POST localhost:3000/eve/v1/dev/schedules/tick`. A thread started under
the dev server cannot continue under `npm start`; the console offers Start over.

```
agent/                      HQ: agent.ts, instructions.md, tools/, schedules/, memory/
agent/subagents/teammate/   the Bot that does the work: its tools, browser, and pilot
agent/lib/                  jobs, board, store drivers, computer, pricing, search, jev
agent/channels/ops.ts       the console API
src/console/                the console
scripts/                    setup, build, start, and the Docker wrapper for Chrome's sandbox
tests/                      vitest
```

Swapping storage means implementing four methods in `agent/lib/store/`.

## Limits

- One computer per deployment, shared by every Bot and workspace. Sign-ins are
  pooled. Use separate deployments for work that must be isolated.
- Backups can be up to `BOT_BACKUP_EVERY_MINUTES` old; browser profiles are not
  archived, the team's sign-ins are.
- Egress is open by default so the browser can install itself. Set an
  allow-list before pointing a Bot at anything sensitive.
- Page content is untrusted. An allow-list is the control that holds, not the
  instruction to ignore text on a page.
- A local computer's Chrome runs without its own sandbox unless eve is given
  the seccomp wrapper in `scripts/`; Docker Compose does this by default.
- The browser pilot has not yet been exercised against a live browser.
- Delivery is at-least-once. Anything a Bot does outwardly should be idempotent
  or gated on approval.

## License

MIT. See [LICENSE](LICENSE).
