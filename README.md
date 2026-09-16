# EVE BOT

A team of always-on AI teammates. Each one has its own computer, works inside the
apps you already use, and keeps going after you close the laptop — coming back
only when something needs your approval.

```
you ──▶ HQ ──assign──▶ job queue ──dispatch──▶ teammate ──▶ browser + shell + files
         │                  ▲                      │
         │                  └── waits until due ────┤
         └──◀ result, or an approval you must sign ─┘
```

## Quickstart

Requires **Node 24+**. Bot runs in one of two places, and the first step is
choosing which:

```bash
npm install
npm run setup    # standalone on your own machine, or Vercel; writes the env file for it
```

**Standalone** means everything on a machine you own: the team's computer in
Docker, models from any OpenAI-compatible API such as Ollama or OpenRouter, and
storage on disk. After setup, `npm run build && npm start` runs it (see
[Run it standalone](#run-it-standalone)).

**Vercel** means Vercel Sandbox, AI Gateway, and Blob, deployed with one click
(see [Deploy](#deploy)). For local development against it:

```bash
npx vercel link && npx vercel env pull   # the team's computer runs on Vercel Sandbox, in dev too
npm run dev                              # Next.js on :3000, with the agent running alongside
```

Without the wizard, `cp .env.example .env.local` and fill in the values it
describes.

The first time a Bot opens its browser, the computer installs Google Chrome and a
display, which takes a few minutes; after that screens start in seconds.

Then open **http://localhost:3000/bot** — the console: your Bots on the left,
the conversation with whichever one you pick in the middle, and its screen and
routines on the right. Approvals appear as cards you answer in place.

Opening the console from another device (an IP or hostname rather than
`localhost`) puts the browser in an insecure context, and noVNC logs
"requires a secure context" when a Bot's screen connects. Run
`npm run dev:https` instead: Next.js serves `https://localhost:3000` with a
locally trusted certificate (generated into `certificates/`, which is ignored).

Then talk to HQ:

```
Hire a bot called Ava who handles inbound sales follow-up. She should be warm
and brief, and never promise a discount.

Ava: pull yesterday's demo list from the CRM and draft a follow-up for each one.
Don't send anything — I'll review the drafts.
```

HQ hires Ava, writes a job with success criteria, and starts it in the
background. (You can also press **+** to create a Bot, then message Ava in her
own thread.) Ava opens the CRM in her browser, works the list, logs each step,
saves a screenshot of what she saw, and comes back with drafts. Ask HQ
`what happened while I was out?` and it reads the feed back to you.

Prefer the terminal? `npm run agent:dev` runs the agent alone with eve's
terminal UI on :2000.

The dev server does not fire schedules. Jobs do not need it, since each run
waits for its own start time, but you can run the watchdog by hand:

```bash
curl -X POST http://localhost:3000/eve/v1/dev/schedules/tick
```

### Run it standalone

Bot also runs as one server on a machine you own, with nothing on Vercel. Put
this in `.env`:

```bash
# The team's computer in Docker instead of Vercel Sandbox (Docker Desktop, OrbStack, Colima, or a Docker host)
BOT_COMPUTER=local

# Models from any API that speaks OpenAI's chat completions format, instead of AI Gateway
BOT_MODEL_BASE_URL=http://localhost:11434/v1   # Ollama; LM Studio is http://localhost:1234/v1
BOT_MODEL=qwen3:8b                             # used everywhere unless BOT_HQ_MODEL / BOT_MODEL_* override it
# BOT_MODEL_API_KEY=                           # if your endpoint needs one
# BOT_MODEL_CONTEXT_TOKENS=128000

# The password you sign in to the console with (openssl rand -base64 32 makes a good one)
BOT_CONSOLE_TOKEN=
```

Then build and start it:

```bash
npm install
npm run build     # the agent (eve build) and the console (next build)
npm start         # both, on http://localhost:3000; PORT changes the port
```

`npm start` runs two processes as one service: the agent, which listens on
`127.0.0.1:4274` only and runs HQ, the Bots, the console API, and the schedules,
and the Next.js console, which proxies to it. Stopping the service stops the
team's computer; the next start picks it back up with its files. Run it under
whatever keeps your other Node services alive, and keep three things on storage
that survives a restart: `.data/` (the roster, jobs, feed, and memory),
`.eve/.workflow-data/` (running jobs and threads), and the Docker volume of the
`bot-computer` container.

Schedules run on their cron cadence in the server's time zone: the watchdog,
the standup, and every routine. During `npm run dev` they do not, and a thread
started under the dev server cannot be continued by the production build (eve
binds development sessions to the dev server); reset such a room, or start from
an empty `.eve/`, when you switch.

The first time a Bot or you opens the computer, eve builds its container and the
computer installs Chrome and a small desktop, which takes a few minutes; after
that it starts in seconds. You watch and take over it in the console as usual: a
small forwarder container publishes its screen on `127.0.0.1:16080` only, and
every connection still needs a single-use token.

Pick a model that handles tool calls well; HQ and the Bots do almost everything
through tools. eve's built-in web search runs through AI Gateway, so on your own
endpoint give Bots a search service of yours: `BOT_SEARCH_PROVIDER=searxng` with
`BOT_SEARCH_URL` pointing at a SearXNG instance keeps searches on your network,
and `brave`, `tavily`, or `exa` with `BOT_SEARCH_API_KEY` use a hosted one.
With none configured, Bots research with their browser.

The USD spend caps hold on your own endpoint once Bot knows what a model costs:
on OpenRouter it reads the price list itself, and anywhere else you set
`BOT_MODEL_PRICES` (`model=input/output` in USD per million tokens, `*` for the
rest). A model with no price counts as free, which is right for one on your own
hardware; per-session token caps (`BOT_*_TOKEN_LIMIT`) stop a runaway loop there.

The same `.env` also works with `npm run dev` for hacking on Bot itself.

#### With Docker Compose

`docker-compose.yml` runs the whole thing as containers: the server, a SearXNG
the Bots search with, and, with `--profile ollama`, a model server too.

```bash
npm run setup                                    # pick Standalone
docker compose up -d --build                     # http://localhost:3000/bot
docker compose --profile ollama up -d --build    # with Ollama alongside
```

The server starts the team's computer as a sibling container through the
Docker socket, so it needs `/var/run/docker.sock` mounted, which the file does.
`.data` and `.eve/.workflow-data` live in named volumes. In `.env`, address other services by
name rather than `localhost`: a model server running on the machine itself is
`http://host.docker.internal:11434/v1`, the Ollama from the profile is
`http://ollama:11434/v1`, and SearXNG is set for you. The agent builds when the
container starts, about ten seconds, because it reads that environment.

## Deploy

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FShaivpidadi%2Feve-bot&project-name=eve-bot&repository-name=eve-bot&env=BOT_CONSOLE_TOKEN&envDescription=A%20long%20random%20password%20you%20sign%20in%20to%20the%20console%20with&envLink=https%3A%2F%2Fgithub.com%2FShaivpidadi%2Feve-bot%23sign-in&stores=%5B%7B%22type%22%3A%22blob%22%2C%22access%22%3A%22private%22%7D%5D)

One click copies this repository to your GitHub, creates the project in your
Vercel account, connects a private Blob store, and deploys. The one thing to
type is `BOT_CONSOLE_TOKEN`, a long random password you sign in to the console
with (`openssl rand -base64 32` makes a good one). AI Gateway, Vercel Sandbox,
Workflow, and Blob all authenticate with the project's OIDC credentials, and
Vercel bills your account for what your Bots use.

### Sign in

Open `/bot` on your deployment and sign in with `BOT_CONSOLE_TOKEN`.

You can also put the whole deployment behind your Vercel login: open **Settings
→ Deployment Protection**, turn on **Vercel Authentication**, and choose **All
Deployments**. Vercel's default, Standard Protection, leaves the production
`.vercel.app` address public, so it is not enough on its own. The console checks
that its own address is protected before it trusts a Vercel login, and the token
keeps working either way.

| | Hobby | Pro |
| --- | --- | --- |
| Good for | trying it out | daily use |
| The team's computer | up to 4 vCPUs; 5 CPU-hours and 20 GB of live view a month, then paused until the next cycle | billed by use |
| Scheduled jobs | start on time; the watchdog runs daily | start on time; `BOT_TICK_CRON="* * * * *"` makes the watchdog run every minute |

From the CLI instead:

```bash
npx vercel link
npx vercel blob create-store bot-store --access private --yes   # the roster, jobs, feed, and memory
npx vercel env add BOT_CONSOLE_TOKEN production                  # your console password
npx vercel deploy --prod
```

It deploys as one Vercel project: `withEve` builds the agent as a service next
to the Next.js app. Schedules become Cron Jobs and sandboxes become Vercel
Sandboxes. Cron expressions are evaluated in UTC.

## What is actually here

| The claim | How it works |
| --- | --- |
| **A computer the team keeps** | One persistent Linux microVM (Vercel Sandbox) shared by HQ and every Bot: one browser the whole team works in, a terminal, and files. One Chrome profile means one set of tabs and sign-ins, so what you sign in to for one Bot is there for the next. It is backed up while Bots work and restored if it is ever replaced. `agent/sandbox/`, `agent/lib/computer*`. |
| **Watch it work, take over when it needs you** | The team's screen sits in the right panel of every thread, HQ's desk included; open it to watch the browser live. When a Bot hits a sign-in, 2FA, or CAPTCHA it asks you to take over; you do that step in the browser and hand it back. Passwords go straight to the page, never through chat. `agent/lib/computer/`, `src/console/computer/`. |
| **A strong default Bot** | Every workspace starts with Atlas, a generalist on the strongest model with the deepest reasoning. Any Bot can create new Bots when you ask. `agent/lib/default-bot.ts`. |
| **Works inside apps, no API needed** | A real Google Chrome on the team's screen, driven through accessibility snapshots with stable `@ref` handles. `agent/subagents/teammate/tools/page_*.ts`. |
| **Keeps working 24/7** | Jobs run as durable Workflow runs. A run survives redeploys and crashes, and a bot waiting on a human holds no compute. `agent/tools/run_job.ts`. |
| **Only comes back for approval** | Irreversible actions are gated on a person (`approval: always()`), and a deliverable can require sign-off that stays pending for a day. Answer one with `POST /bot/v1/rooms/:room/respond` — a plain message starts a new turn instead of resolving the request. |
| **Message them like a colleague** | HQ's desk plus a thread per bot, each a durable conversation that is still there tomorrow. A Next.js console at `/bot` shows the roster with live presence, each bot's chat, its screen, and its routines. `agent/channels/ops.ts`. |
| **They remember and get sharper** | Three eve memory slots (per-person, per-workspace, per-craft) plus a per-bot playbook replayed into every brief. Open **Memory** in the sidebar to see what they remember and add or forget an entry. `agent/lib/memory.ts`. |
| **Finishes end to end** | Every job carries explicit success criteria, the bot must verify its own work, and results record whether they were verified. |

## The console

The console is a Next.js App Router app written in TypeScript, in `src/`.
`next.config.ts` wraps it with eve's `withEve`, so one dev server and one deploy
run both the UI and the agent, and the browser talks to the agent's `/bot/v1`
routes on the same origin. It is organised around Bots, not chats:

- **Roster.** Every Bot has a name, a title, and an avatar whose motion shows
  its state: idle, thinking, working, waiting on you, blocked, or done. Hover
  an avatar to see what it is doing right now. HQ sits at the top.
- **Chat.** Each Bot has one durable thread. The transcript mixes messages
  with events — routines created, jobs handed off, a collapsible list of the
  steps a Bot logged — and inline cards: an email waiting to be sent, a
  deliverable waiting for sign-off, a question.
- **Computer.** The title-bar icon turns purple while a Bot's computer is
  working. The panel shows a still of its screen; click it to open the computer
  full screen: the Bot's own desktop, live, with a dock for its **Browser**
  (Chrome), **Files**, and **Terminal**. **Take control** to use it yourself;
  **Return control** hands it back. When a Bot needs you (a sign-in, a code, a
  CAPTCHA), a banner says so wherever you are in the console, the screen shows
  what it needs, and returning control, with an optional note, tells it to
  carry on. **Files** in the top bar uploads to and downloads from the computer.
- **Routines and files** for the selected Bot, plus its persona, playbook, and
  a pause switch under settings.

The page polls `/bot/v1/state` for the roster and feed, follows the selected
room's NDJSON stream from its cursor (so a reload replays the thread), and
posts answers to `/respond`.

## Plugins

Connect a service once and every Bot can use it. Open **Plugins** in the console sidebar and add an MCP server by its
address, with no key, a bearer key, or a key in a custom header. The console
reaches the server first and saves it only if it answers with its tools. Keys
are stored encrypted and unsealed only inside a Bot's connection; the model
never sees them.

A Bot finds plugin tools with `connection_search` and calls them as
`<plugin>__<tool>`. It prefers a plugin over clicking through a website, and
uses its browser for anything no plugin covers. Tick **Ask me before a Bot first
uses it in a job** for services that can change or send things.

`agent/lib/plugins.ts` holds the store and the connection check;
`agent/subagents/teammate/connections/plugins.ts` hands the enabled plugins to
each job. v1 connects servers that speak Streamable HTTP. Sign-in with OAuth
(catalog connectors such as Google Drive or Notion) is not
built yet.

## Talking to it over HTTP

Each console token is bound to one workspace: `BOT_CONSOLE_TOKEN` opens the
default workspace, and `BOT_CONSOLE_TOKENS="token=workspace,…"` adds more. Send
it as `Authorization: Bearer <token>`; the browser console signs in once and
keeps it in an HttpOnly cookie. With no token the routes are open, but only on a
local dev server; a deployment refuses to serve them unless you set a token (or
`BOT_CONSOLE_OPEN=1`). Through `npm run dev` these routes are on port 3000.

Rooms are `desk` for HQ and `bot-<botId>` for a Bot's own thread.

```bash
# Say something to a room (creates or resumes that room's durable session)
curl -X POST localhost:3000/bot/v1/rooms/desk/messages \
  -H 'content-type: application/json' \
  -H 'x-bot-user: you@example.com' \
  -d '{"message":"Who is on the team?"}'

# Answer a pending approval or question (requestId comes off the stream)
curl -X POST localhost:3000/bot/v1/rooms/desk/respond \
  -H 'content-type: application/json' \
  -d '{"responses":[{"requestId":"<id>","optionId":"approve"}]}'

# Follow a room live (NDJSON), from an event index
curl -N 'localhost:3000/bot/v1/rooms/desk/stream?startIndex=0'

# The roster with presence, routines, and files, plus the feed
curl localhost:3000/bot/v1/state

# Create, pause, or resume a Bot
curl -X POST localhost:3000/bot/v1/bots -H 'content-type: application/json' \
  -d '{"name":"Ava","role":"Inbound sales follow-up","persona":"Warm and brief. Never promises a discount."}'
curl -X PATCH localhost:3000/bot/v1/bots/<botId> -H 'content-type: application/json' -d '{"status":"paused"}'
```

## Layout

```
next.config.ts                  withEve, plus forwarding for the console's /bot/v1 API
scripts/setup.mjs               npm run setup: standalone or Vercel, models, search, token; writes the env file
scripts/build.mjs               npm run build: the agent, then the console (only the console on Vercel)
scripts/start.mjs               npm start: the built agent and the console as one standalone server
Dockerfile, docker-compose.yml  the standalone server as containers, with SearXNG and optionally Ollama
src/
├── app/bot/page.tsx            the console
├── app/bot/login/page.tsx      sign-in with a console token
├── console/                    roster, chat, cards, stream reader
└── console/computer/           the computer: live desktop (noVNC), takeover, file transfer
agent/
├── agent.ts                    HQ: the teammate you message
├── instructions.md             how HQ behaves
├── instructions/room.ts        in a Bot's thread, HQ speaks as that Bot
├── channels/ops.ts             the console API: rooms, streaming, state, approvals
├── schedules/tick.ts           the watchdog that re-dispatches stranded jobs
├── schedules/standup.ts        a daily report, written like a person would
├── hooks/audit.ts              durable record of approvals and failures
├── memory/profile.ts           how this operator likes things done
├── memory/team.ts              conventions shared across the workspace
├── skills/running-the-team.md  loaded when HQ writes a brief
├── tools/                      hire_bot, assign_job, run_job, job_status, …
├── sandbox/                    the team's one computer, and what is seeded into it
├── lib/computer.ts             every session opens the same computer
├── lib/computer-config.ts      Vercel Sandbox by default, a local VM on request
├── lib/computer-backup.ts      archive the computer, restore it onto a replacement
├── lib/computer/script.ts      the software on the computer: screens, desktop, gateway
├── lib/computer/runtime.ts     start screens, sign-ins, files
├── lib/computer/screens.ts     the team's screen, who is on it, and who has control
├── lib/computer/http.ts        the console's live view, takeover, and files
├── lib/default-bot.ts          the generalist every workspace starts with
├── lib/                        persistence, job queue, briefs, artifacts
└── subagents/teammate/         the bot that does the work
    ├── agent.ts                its model, reasoning depth, and spend limit
    ├── instructions.md         verify before you claim; the computer; web apps
    ├── sandbox.ts              works on the parent's computer: the shared one
    ├── memory/craft.ts         lessons about doing this work well
    ├── lib/browser.ts          agent-browser on the Bot's own visible Chrome
    └── tools/                  browse, page_*, request_takeover, log_progress,
                                save_artifact, learn, send_email, create_bot, finish_job
```

## How the pieces fit

**Jobs are records, not conversations.** `assign_job` writes a job to durable
storage with a brief, success criteria, a schedule, and a sign-off flag. That
record is the contract: a teammate re-reads it with `job_brief` rather than
trusting the message it was started with.

**Jobs keep their own time.** `run_job` checks the job first. If it is not due,
the run takes a `wait` lease and sleeps durably until the start time: no poller,
no compute while it waits, and on time on any Vercel plan. A rescheduled job is
simply waited on again. A routine's run keeps going on its own: after each cycle
it posts a report to the thread and waits for the next start, handing off to a
fresh run after a day so new deployments take over. `tick` is only a watchdog. Daily by default, it reads an index
of open jobs (never the whole history), finds work that is due with nothing
waiting on it — a wait that was cancelled, a run whose lease lapsed because it
really died — claims each one atomically, and wakes HQ in that job's room. A
claim is a versioned write, not a flag, so nothing double-dispatches. Paused
Bots' jobs wait quietly until they resume.

**`run_job` is where the durability lives.** It is a background workflow tool, so
the conversation continues the moment work starts. Inside, it claims the job in a
step and delegates to the teammate, renewing a short lease on a durable
heartbeat for as long as the Bot works, so a long job is never mistaken for a
dead one. If the job needs sign-off, the job parks as blocked under a sign-off
lease, asks a human, and suspends. Nothing is held open while it waits; the run
resumes when the answer arrives, minutes or a day later. Sending the work back
with a note puts the job back in the queue with the note in its brief, next to
the result it is about, and HQ starts a fresh run for the revision. A run's later
review cards do not reach the thread, so every review is the first card of its
run. A run only closes a job
it still owns, a cancelled job stays cancelled, and a failed or sent-back job
can be run again.

**One computer, kept.** eve gives every session its own sandbox; Bot wraps the
backend so every session opens the same persistent machine, while each keeps its
own browser session and scratch folder. Vercel keeps the machine's snapshots
without expiry, and on top of that the computer's files are archived to Blob
every `BOT_BACKUP_EVERY_MINUTES` while Bots work and at the end of every job. A
marker file tells an original machine from a replacement; a replacement gets the
latest archive restored before the next job starts.

**A screen you can watch and take over.** The team has one screen on the
computer, shared by HQ and every Bot and shown on every thread: a TigerVNC
display with a small desktop. Openbox manages the
windows, a tint2 dock opens the Browser (Google Chrome, with DevTools on
localhost), Files (pcmanfm), and a Terminal (xfce4-terminal), and there is
nothing else: no menus, no desktop icons. agent-browser attaches to that Chrome,
so everything a Bot does happens where you can see it, and the Bot brings the
browser back to the front before it acts. Because it is one Chrome profile, the
tabs and sign-ins a person or a Bot leaves are there for whoever works next;
the trade-off is that two Bots working at the same moment share that one
browser and its active tab. The computer exposes a single port, a
websockify gateway, and it only lets a connection through with a fresh,
single-use token the console signs after checking who you are. The console shows
that screen full size over noVNC, view-only until you take control. The screen
starts on demand, restarts after the computer resumes from a snapshot, and stops
after `BOT_COMPUTER_IDLE_MINUTES` without use.

**Handing a step to a person.** When a Bot hits a sign-in, a code, or a CAPTCHA
it calls `request_takeover`, which pauses it on an approval. A hook inside the
teammate records the handover on the team's screen, so the roster shows the Bot
waiting on you, a banner says so anywhere in the console, and the screen shows
what it needs. Taking control sets a lock every Bot's browser tools respect;
returning control, with an optional note, approves the request, saves whatever
you signed in to into the team's jar so backups carry it, and gives the Bot your
note and a fresh look at the page. If the computer slept meanwhile, taking control reopens
the page the Bot was on.

**Approvals are structural, not advisory.** `send_email` and `retire_bot` are
gated with `approval: always()`. The prompt surfaces on the operator's channel
even though the bot that raised it is a subagent two levels down.

**Learning is two layers.** A bot's `playbook` is explicit and inspectable — the
bot appends to it with `learn`, and it is replayed into every future brief. The
memory slots are implicit: recalled automatically at the start of a turn, scoped
so one person's preferences never leak into another's.

## Persistence

One small interface (`get` / `put` / `delete` / `list`, with version tokens) and
three drivers:

| Driver | Used when | Concurrency |
| --- | --- | --- |
| Vercel Blob | on Vercel, or when Blob credentials are set | ETag `ifMatch` — a true compare-and-set across instances (read ETags are normalized to their strong form, which `ifMatch` requires) |
| Local disk | `eve dev` and a standalone server (`.data/`) | in-process key locking; single-process only |
| In-memory | tests, throwaway | in-process key locking |

Job claims, playbook edits, and stats all go through one read-modify-write helper
that serializes cycles per key in-process and re-reads on a version conflict.
Swapping in Postgres or Redis means implementing four methods in
`agent/lib/store/`.

## Configuration

Everything is optional except a model credential. See `.env.example`. The knobs
worth knowing:

| Variable | Does |
| --- | --- |
| `AI_GATEWAY_API_KEY` | model access (or link a Vercel project and use OIDC) |
| `BOT_HQ_MODEL` / `BOT_HQ_REASONING` | HQ's model (Sonnet) and reasoning depth (`low`) |
| `BOT_MODEL_QUICK` / `BOT_MODEL_STANDARD` / `BOT_MODEL_DEEP` | the model a job runs on at each effort level (see below) |
| `BOT_TEAMMATE_MODEL` | one model for every job, overriding the effort levels |
| `BOT_TEAMMATE_REASONING` | teammate reasoning depth: `medium` (default), `low`, `high`, `xhigh` |
| `BOT_DEFAULT_BOT_NAME` | name of the generalist every workspace starts with (default `Atlas`) |
| `BOT_COMPUTER` | where the computer runs: `vercel` (default, in development too) or `local` (Docker on this machine, for a standalone server or development) |
| `BOT_COMPUTER_NAME` | the shared computer's name; a new name starts a new machine |
| `BOT_COMPUTER_MAX_SCREENS` / `BOT_COMPUTER_IDLE_MINUTES` | how many Bot browsers run at once, and when an unused one stops |
| `BOT_COMPUTER_KEY` | pins the key live-view tokens are signed with (generated and stored otherwise) |
| `BOT_BACKUP_EVERY_MINUTES` / `BOT_BACKUP_MAX_MB` | how often the computer is archived while Bots work, and the archive size limit |
| `BOT_STORE` | force `blob`, `fs`, or `memory` |
| `BOT_CONSOLE_TOKEN` / `BOT_CONSOLE_TOKENS` | console tokens, each bound to one workspace |
| `BOT_CONSOLE_AUTH` | `token` accepts console tokens only, even behind Vercel Authentication |
| `BOT_TICK_CRON` | how often the watchdog re-dispatches stranded jobs (daily by default; `* * * * *` on Pro) |
| `BOT_CONSOLE_OPEN` | `1` serves the console without a token on a deployment (not recommended) |
| `BOT_SANDBOX_ALLOW_DOMAINS` | firewall the bot's computer to an allow-list |
| `BOT_BROWSER_ALLOWED_DOMAINS` | fence the browser to specific hosts |
| `BOT_EMAIL_WEBHOOK` | where approved email actually goes; unset returns drafts |
| `BOT_HQ_COST_LIMIT_USD` / `BOT_JOB_COST_LIMIT_USD` | per-session spend caps (`10` / `5`); a job started from a thread also draws on what the thread has left |
| `BOT_SEARCH_PROVIDER` / `BOT_SEARCH_URL` / `BOT_SEARCH_API_KEY` | web search on your own endpoint: `searxng` at your own URL, or `brave`, `tavily`, `exa` with a key; unset, Bots search in their browser |
| `BOT_MODEL_PRICES` | what models on your own endpoint cost, `model=in/out` in USD per million tokens, so the caps hold there; OpenRouter's list is read on its own |
| `BOT_HQ_INPUT_TOKEN_LIMIT` / `BOT_HQ_OUTPUT_TOKEN_LIMIT` / `BOT_JOB_INPUT_TOKEN_LIMIT` / `BOT_JOB_OUTPUT_TOKEN_LIMIT` | per-session token caps on your own endpoint (40M / 2M / 10M / 500k), the backstop for a model nothing prices; `off` uncaps one |

### Which model does a job

HQ rates every job's effort when it assigns it, and the job runs on that
level's model:

| Effort | For | Default model | Per million tokens (in / out) |
| --- | --- | --- | --- |
| `quick` | lookups, status checks, simple recurring monitors | `alibaba/qwen3.8-flash` | $0.16 / $0.47 |
| `standard` | most work: operating web apps, reading, drafting | `anthropic/claude-sonnet-5` | $2 / $10 |
| `deep` | hard research, analysis, coding, high-stakes work | `anthropic/claude-opus-5` | $5 / $25 |

A job that fails re-runs one level up. The defaults are models the AI Gateway
lists as neither retaining nor training on prompts, because Bots read inboxes
and documents; check that before pointing a level at a promotional or free
model.

## Known limits

- **A redeploy may not reach a thread that is already running.** eve gives an
  existing thread's next turn the new deployment's instructions, model, and
  tools, but in testing a thread kept running an older build's code until it
  was started over. If a thread keeps failing after you upgrade, start it over:
  `curl -X POST -H "authorization: Bearer $BOT_CONSOLE_TOKEN"
  https://<your-app>/bot/v1/rooms/desk/reset` for HQ, or `rooms/bot-<botId>` for
  a Bot. That clears the thread's conversation and cancels its open jobs; the
  roster, finished work, and memory stay.
- **No automated tests yet.** Changes are checked with `npm run typecheck`,
  `npm run agent:build`, and `npm run build`.
- **The computer uses Vercel Sandbox by default, even locally.** Run `vercel link
  && vercel env pull`, or set `BOT_COMPUTER=local` to run it in Docker on your
  machine (see [Run it standalone](#run-it-standalone)).
- **A local computer's Chrome runs without its own sandbox.** An ordinary Docker
  container does not grant the Linux namespaces Chrome's sandbox needs, so the
  container is the isolation boundary. A microsandbox VM
  (`BOT_COMPUTER_LOCAL=microsandbox`) is for development only: the console
  cannot open it, and a production server refuses it.
- **Dev threads do not carry over to a standalone server.** eve binds a thread
  started under `npm run dev` to the dev server, so `npm start` fails its next
  turn with "resumed outside a generation-bound delivery". Reset the room, or
  start the server from an empty `.eve/`.
- **Live view is a public URL with a token.** Sandbox ports are reachable by
  anyone with the address, so the gateway admits only single-use tokens that
  expire within a minute. Watching is view-only in the console; the server does
  not yet enforce view-only on a connection.
- **Some sites challenge sign-ins from cloud machines.** Google and others may
  ask for extra verification from a sandbox's IP. Take over and complete it, or
  set `BOT_BROWSER_PROXY`.
- **Viewing costs a little.** A live view streams from the sandbox, which counts
  as Vercel Sandbox data transfer. The thumbnail in a Bot's panel streams too,
  at low picture quality, but only while that Bot's browser is already running
  and the tab is in view. It never starts a browser or keeps the computer
  awake; otherwise it shows the last still frame, marked asleep.
- **The console API rides on eve's Vercel routing.** `withEve` only routes
  `/eve/v1` to the agent, so `next.config.ts` adds `/bot/v1` to the same
  forwarding: a rewrite locally, and a route in the Build Output config eve
  generates on Vercel (under `/vercel/output` on Vercel's builders). If an eve
  upgrade moves that config, the build log warns that `/bot/v1` is not routed.
- **In a Bot's thread, HQ answers in that Bot's voice.** It is one agent with
  the Bot's persona and playbook, delegating the actual work to the teammate.
- **The computer is shared, by design.** Every Bot, and every workspace on one
  deployment, works on the same machine. Bots get their own folders and browser
  sessions, but nothing stops one Bot from reading another's files. Run a
  separate deployment, or set a different `BOT_COMPUTER_NAME`, for work that
  must be isolated. Sign-ins are pooled too: once someone signs in on one Bot's
  browser, every Bot's browser is signed in. Bots have sudo on the computer, so
  a Bot can read the saved sign-ins; keep egress allow-listed.
- **Backups can be minutes old.** A replacement computer comes back as of the
  last backup: up to `BOT_BACKUP_EVERY_MINUTES` of work inside a job can be
  lost. Browser profiles are not archived; the team's sign-ins are, and a
  replacement computer's browsers start signed in.
  Computers over `BOT_BACKUP_MAX_MB` compressed are not backed up; the feed says
  so. The just-bash fallback has no `tar`, so it cannot be backed up.
- **A lost wait is caught by the watchdog, not instantly.** If a job's waiting
  run disappears (its thread was started over while it waited), the job starts
  on the watchdog's next pass: up to a day later with the daily default.
- **Owner access is checked every few minutes.** Turning Vercel Authentication
  off locks the console within about 20 seconds for new checks, but a check that
  passed is trusted for up to 5 minutes.
- **Effort is HQ's judgment call.** A job rated too low fails once and re-runs a
  level up, which costs a retry. Pin a level with `BOT_MODEL_*`, or every job
  with `BOT_TEAMMATE_MODEL`. Browser work re-sends the page on every step, so
  it is where the model's price shows most.
- **Artifacts are capped at 2 MB** and stored as base64 documents. Bigger outputs
  belong in the destination system, with the bot linking to them.
- **Egress is open by default** because the browser installs itself on first use.
  Set an allow-list before pointing a bot at anything sensitive.
- **`send_email` is a seam, not an integration.** Point it at your sender.
- **Delivery is at-least-once.** A crash between dispatch and completion re-runs
  the job, so anything a bot does outwardly should be idempotent or gated on
  approval.
- **Egress and page content are untrusted.** Web pages can contain text that
  looks like instructions; the teammate's instructions say to treat it as data,
  but an allow-list is the control that actually holds.

## License

MIT. See [LICENSE](LICENSE).
