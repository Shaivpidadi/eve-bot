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
| Models | AI Gateway | Ollama, LM Studio, OpenRouter, any OpenAI-compatible API |
| Storage and memory | Vercel Blob | disk |
| Schedules | Vercel Cron | the server's own cron |
| Web search | eve's, through AI Gateway | your SearXNG, or Brave, Tavily, Exa |
| Costs | billed by Vercel | whatever your endpoint charges; caps still hold |

### Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FShaivpidadi%2Feve-bot&project-name=eve-bot&repository-name=eve-bot&env=BOT_CONSOLE_TOKEN&envDescription=A%20long%20random%20password%20you%20sign%20in%20to%20the%20console%20with&envLink=https%3A%2F%2Fgithub.com%2FShaivpidadi%2Feve-bot%23vercel)

The button copies this repository to your GitHub, creates the project, and
deploys. It asks for one thing: `BOT_CONSOLE_TOKEN`, the password you sign in
with (`openssl rand -base64 32` makes a good one).

Then give it storage: in the project's **Storage** tab, create a Blob store
(private access is fine) and connect it to the project, then redeploy. The
roster, jobs, and memory live there. Open `/bot` on your deployment; its
setup page checks each step off until the console opens.

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
tools.

## Keeping it up to date

A deployment made with the Deploy button is a copy of this repository in your
GitHub account, not a fork, so nothing pulls new releases in by itself. The
copy carries a workflow, **Sync with upstream**, that does: once a week, and
whenever you run it from your repository's Actions tab, it merges this
repository's `main` into yours and pushes, and Vercel deploys the result. If
you changed code in your copy and the two conflict, it leaves the merge on an
`upstream-sync` branch with the conflicts marked and fails, so you can finish
it by hand. Set a repository variable `BOT_SYNC_UPSTREAM=off` to stop it.

The console says when a newer version is out: "Update now" in the sidebar's
footer opens your copy's sync workflow, where **Run workflow** does it and
Vercel redeploys. It asks GitHub for this repository's version at most every
six hours; `BOT_UPDATE_CHECK=off` stops it asking.

A copy deployed before this workflow existed needs one manual sync to receive
it. Its first commit has no history in common with this repository, so graft
it onto the commit whose files it matches, then merge:

```bash
git clone https://github.com/<you>/<your-copy> && cd <your-copy>
git remote add upstream https://github.com/Shaivpidadi/eve-bot.git && git fetch upstream main
root=$(git rev-list --max-parents=0 HEAD | tail -1)
git replace --graft "$root" "$(git log --format='%H %T' upstream/main | awk -v t="$(git rev-parse "$root^{tree}")" '$2==t{print $1; exit}')"
git merge upstream/main -m "chore: sync with upstream eve-bot" && git push
```

Vercel deploys the push. From then on the workflow keeps the copy current.

Standalone, update the way you installed:

```bash
git pull && npm install && npm run build && npm start     # or: docker compose up -d --build
```

Stored data is carried forward. A release that changes what is stored reads
the old shape and writes the new one the first time it is needed, so a
deployment can skip versions. Some releases also need a decision from you;
see [Upgrading to this version](#upgrading-to-this-version).

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
- **Approvals.** Sending email, retiring a Bot, any connector tool that
  changes something, and any browser click that could send, spend, delete or
  save stop for a person first. See [Safety model](#safety-model).
- **Memory.** The team remembers on its own. After each exchange with HQ, and
  after each job, Jev judges whether anything said is worth keeping, a small
  model phrases it, and it lands in one of three shared slots: about you, your
  team, how to do your work. The facts that are really fields (name, company,
  timezone, date and time formats, spelling, who approves what, where tickets
  live) are kept as fields with one current value each, so a change is an
  overwrite with history rather than a second sentence, and they always fit in
  what HQ and the Bots recall. It learns from what you do as well as what you
  say: a job sent back with a note, and an action you decline when a Bot asks
  first, go through the same gate. What you forget by hand stays forgotten.
  Each memory carries how sure the team is of it, from who saved it and what
  Jev made of it, rising when you say it again; what nobody has needed for
  ninety days fades out of recall but stays on the page. On the Gateway the
  Bots' lessons are ranked by meaning, with a small embedding per lesson, so
  "the export drops rows" is found for "CSV loses data"; elsewhere by words.
  How you want things written (spelling, dates, times, tone, length, rules
  such as "no em dashes") reaches HQ and the Bots as instructions on every
  turn, not as recalled data, so it holds in chat replies as well as drafts. HQ and every Bot recall what is relevant on each
  turn. When a preference moves on, the memory is reworded and keeps its old
  wording; when something stops being true, it is retired, not lost. Open
  **Memory** in the console to search it, pin what should always be recalled,
  correct it, bring a retired memory back, or forget it. Each Bot also keeps a
  playbook.
- **Connectors.** Connect Linear, Notion, Atlassian or Sentry with one click
  and no setup: the server signs you in through its own OAuth, this app
  registers itself as a client, and the token is kept sealed per workspace so
  every Bot and every routine can use it. GitHub and a documentation source
  are added by name (GitHub takes a token, since GitHub does not register
  clients on its own), and any MCP server by address; a custom server that
  needs OAuth is detected when it is added. Each connector has its own page:
  its account, every tool with a switch and a read-or-change tag, when a
  person is asked first, and the facts about it. Tools that change something
  ask first, and HQ only uses the reads a person confirmed. When a Bot needs an account nobody has connected yet, the thread
  says so with a button to the Connectors page, and the work carries on once
  it is connected.

## The console

`/bot`: your Bots on the left, the selected thread in the middle, the team's
screen and the Bot's routines on the right. Right-click a Bot, or use the **⋯**
on hover, for its menu: pin, move to a section, mark unread, clear chat,
rename, edit profile, duplicate, copy conversation id, hide, delete. Pins,
sections, and hiding are saved on the Bot; unread is yours alone.

**Usage**, in the sidebar's footer, opens a sheet over the console (as do
Memory and Connectors, so the conversation stays in view; click outside or
press Escape to close) with what the workspace has spent
on models: the total, the last seven days, a bar per day for the last thirty,
and tables by model, by who ran it (HQ and each Bot), and job by job, with
tokens in and out, cache reads, and the price the provider reported. The
thread panel repeats each member's own figures, and every finished job carries
its line in the feed. Off AI Gateway a provider reports no price, so set
`BOT_MODEL_PRICES` to see dollars instead of zeros.

The **budget** card on the same page is the workspace's spending limit for
the month (`BOT_BUDGET_MONTHLY_USD`, and `BOT_BUDGET_DAILY_USD` for a daily
one). Everything that calls a model draws on it: HQ, every job run, each
routine cycle and retry, Jev's judgements and memory. A run reserves an
estimate for its effort before it starts and gives back what it did not spend
when it ends; a run that would not fit is blocked with the reason, and one
that overruns its reservation once the month is used up is stopped before its
next model step and blocked. Calls whose provider reported no price are
counted as unpriced rather than as free. The computer's runtime counts too
once you set its rate from your Vercel plan (`BOT_COMPUTER_USD_PER_HOUR`, or
per active-CPU hour and per GB-hour): the watchdog charges each finished
Sandbox session to the workspace, once. Without a rate it shows as unpriced.

Behind Vercel Authentication the console shows who is signed in, with their
Vercel name and picture. Elsewhere it shows the name in `X-Bot-User`, or the
name you set by clicking the footer of the sidebar; HQ and the Bots use that
name too.

A thread that accepts a message and never answers is restarted on its own:
after about a minute without a turn, the console moves it to a fresh session,
sends the message again, and says so in the thread. The conversation shown
stays, but the new session only knows what is in Memory. The same happens
when the next message arrives over the API. eve 0.58 can leave a session in
that state after the dev server reloads or after certain task interactions.

Opening the console from another device over plain http puts the browser in
an insecure context, and the live screen will not connect. Use
`npm run dev:https`, or on a standalone server set `BOT_COMPUTER_LOCAL_BIND=0.0.0.0`
and serve over http, or put the gateway behind TLS.

## Safety model

What stops a Bot from doing something nobody meant, and what does not. The
store decisions behind it are in
[docs/decisions/0001-state-store.md](docs/decisions/0001-state-store.md).

**Run fencing.** A job is worked by one run at a time, the holder of its
lease. A Bot's session is bound to that run when it reads its brief, and every
job write and every outward action (email, connector call, browser action,
`create_bot`) checks it still is. A run whose lease lapsed and was taken over,
or whose job was cancelled, is refused, even holding an approval it was given
earlier.

**Cancellation.** Stop in the console (`DELETE /bot/v1/jobs/:id`) cancels the
job durably and stops its sessions immediately. Cancelling from a chat
(HQ's `cancel_job`) refuses all of the Bot's actions immediately, kills the
run's shell commands, and stops the Bot before its next model call (a context
compaction included); a run waiting on an approval card ends within a minute.
Either way nothing can mark the job done afterwards.

**Connectors.** Every tool has a recorded effect, read or change. A tool
nobody classified, one the server grew since its last check, or one whose
name says it can run anything (SQL, HTTP, shell) counts as a change and needs
approval under the "before changes" gate. HQ never asks, so it only gets
reads a person confirmed (the "reads?" chips, or **Review** on the connector's
page) or that the catalog vouches for. Every call re-reads the connector, so
switching it or a tool off, re-marking a tool, or rotating a key bites on the
next call. An approval is recorded with the permission version the person was
asked under, only if the settings have not changed since, and stops counting
once any of them change. An approval that lands after the job was cancelled or
taken over, or for a tool switched off or a connector removed since the
request, is rejected: the call never runs, and the person denies the card. Approvals are structured
answers sent through the signed-in console (`/respond`); a plain "yes" typed
into a chat is a new message, not an approval.

**Browser.** Every click, Enter, selection, checkbox and upload is classified
first. It asks when the control's words send, spend, publish, delete, confirm
or save a change ("Save", "Add member", "Apply"), when it submits a non-GET
form or a form posting to another site, on checkout and payment pages, when
the element cannot be inspected, and for every file upload. Typing, plain
navigation, and whole labels that only rearrange the page ("Apply filters",
"Clear search", "Reset zoom") on a control that submits nothing do not. An
approval is bound to the exact page address (query and fragment included) and
the element as it looked: its role, name, form target, its row and position
among same-named elements, and the field's value for an Enter. If any of that
changed, or the page renumbered the ref, it asks again. Residual risk: a
consequential button with an innocuous label ("Continue", "Done") that runs
page script without a form is not caught by words or structure. Use an egress
allow-list for anything sensitive.

**Email.** Each send is recorded in an action ledger before it goes out, with
an id bound to the run and the exact payload, and the relay receives it as
`Idempotency-Key`. Delivery toward the relay is at least once, so the relay
must dedupe; see [Outbound email relay](#outbound-email-relay).

**Budgets.** `BOT_BUDGET_MONTHLY_USD` and `BOT_BUDGET_DAILY_USD` cap what the
workspace spends on models, per UTC month and day. A run reserves an estimate
before it starts; one that would not fit is blocked with the reason. Spend is
counted after each model step, so the limit can be overshot by the steps in
flight when it runs out: a run past its reservation with no budget left is
halted before its next step. A step whose provider reported no cost is counted
and shown as unknown, never as free. Vercel Sandbox runtime is charged to the
workspace once you set its rate (`BOT_COMPUTER_USD_PER_HOUR` and friends),
up to a day late on Hobby; until then it is shown as unpriced.
`BOT_JOB_COST_LIMIT_USD` and `BOT_HQ_COST_LIMIT_USD` still cap each session.

### Upgrading to this version

- **Confirm HQ's connector reads.** HQ now uses only reads a person
  confirmed, so after the upgrade it has no tools from a custom connector, and
  only the catalog-vouched ones from a built-in. Open each connector under
  **Connectors**; where it says tools guessed as reads need your confirmation,
  click **Review**, untick anything that changes something, and confirm.
  Bots keep working meanwhile.
- **Check the email relay.** If `BOT_EMAIL_WEBHOOK` is set, make sure the
  relay dedupes on `Idempotency-Key` and answers as the
  [contract](#outbound-email-relay) describes. `BOT_EMAIL_WEBHOOK_TIMEOUT_MS`
  sets how long Bot waits (`30000`).
- **Set a budget.** Without `BOT_BUDGET_MONTHLY_USD` (and optionally
  `BOT_BUDGET_DAILY_USD`) spend is tracked but not capped.
- **Standup room.** The standup now posts to HQ's `desk` by default. A
  `BOT_STANDUP_ROOM` that is not `desk` or a Bot's room (`bot-<id>`), such as
  the old example `standup`, is ignored with a warning; remove it or point it
  at a room the console shows.

## HTTP

Send `Authorization: Bearer <console token>`. Rooms are `desk` for HQ and
`bot-<botId>` for a Bot.

```bash
curl -X POST localhost:3000/bot/v1/rooms/desk/messages -H 'content-type: application/json' -d '{"message":"Who is on the team?"}'
curl -N 'localhost:3000/bot/v1/rooms/desk/stream?startIndex=0'          # NDJSON, live
curl -X POST localhost:3000/bot/v1/rooms/desk/respond -H 'content-type: application/json' -d '{"responses":[{"requestId":"<id>","optionId":"approve"}]}'
curl -X POST localhost:3000/bot/v1/rooms/desk/reset                       # start the thread over
curl -X POST localhost:3000/bot/v1/rooms/desk/recover -H 'content-type: application/json' -d '{"message":"…"}'  # a thread that stopped answering: fresh session, message sent again
curl -X POST localhost:3000/bot/v1/connectors -H 'content-type: application/json' -d '{"catalog":"linear"}'      # add a connector; OAuth ones then need a sign-in
curl -X POST localhost:3000/bot/v1/connectors/<id>/reviewed-reads -H 'content-type: application/json' -d '{"tools":["list_issues"]}'  # confirm guessed reads for HQ; no "tools" = all of them
curl -X POST localhost:3000/bot/v1/connectors/<id>/oauth/start                                                 # the consent URL to open; the server sends the browser back to /bot/v1/oauth/callback
curl localhost:3000/bot/v1/state                                          # roster, presence, feed
curl -X POST localhost:3000/bot/v1/bots -H 'content-type: application/json' -d '{"name":"Ava","role":"Inbound sales follow-up","persona":"Warm and brief."}'
curl -X PATCH localhost:3000/bot/v1/bots/<id> -H 'content-type: application/json' -d '{"status":"paused","pinned":true,"section":"Sales"}'
curl -X POST localhost:3000/bot/v1/bots/<id>/duplicate
curl -X DELETE localhost:3000/bot/v1/bots/<id>
```

The front door is readable by agents too: `/`, `/about`, `/contact`, and
`/privacy` answer `Accept: text/markdown` with Markdown, unknown paths answer
404 the same way, `/llms.txt` says when to reach for Bot, and `/sitemap.xml`
lists the public pages. The console and `/eve` stay out of all of it.

## Configuration

Everything is optional except a model credential. `.env.example` documents all
of it; these are the ones that matter.

| Variable | Does |
| --- | --- |
| `AI_GATEWAY_API_KEY` | model access on Vercel (or link the project and use OIDC) |
| `BOT_MODEL_BASE_URL` / `BOT_MODEL` / `BOT_MODEL_API_KEY` | your own OpenAI-compatible endpoint and the model used everywhere on it |
| `BOT_MODEL_QUICK` / `BOT_MODEL_STANDARD` / `BOT_MODEL_DEEP` | the model at each effort level; HQ routes between the last two |
| `BOT_HQ_MODEL` | pin HQ to one model |
| `BOT_COMPUTER` | `vercel` (default) or `local` |
| `BOT_COMPUTER_LOCAL_BIND` | where a local computer's live view is published; `127.0.0.1` by default |
| `BOT_SEARCH_PROVIDER` / `BOT_SEARCH_URL` / `BOT_SEARCH_API_KEY` | web search on your own endpoint: `searxng`, `brave`, `tavily`, `exa` |
| `BOT_MODEL_PRICES` | `model=in/out` USD per million tokens, so spend caps hold off Gateway; OpenRouter is read automatically |
| `BOT_HQ_COST_LIMIT_USD` / `BOT_JOB_COST_LIMIT_USD` | per-session spend caps (`10` / `5`) |
| `BOT_BUDGET_MONTHLY_USD` / `BOT_BUDGET_DAILY_USD` | workspace spend limit per UTC month / day; unset = no limit, spend still tracked |
| `BOT_COMPUTER_USD_PER_HOUR` / `_PER_CPU_HOUR` / `_PER_GB_HOUR` | the computer's rate from your Vercel plan, so its runtime counts on the budget; unset = unpriced |
| `BOT_MEMORY_FLOOR` | how sure Jev must be before something is remembered (`0`–`1`; defaults to `BOT_JEV_CONFIDENCE`) |
| `BOT_MEMORY_MODEL` | the model that reads exchanges for memories (`anthropic/claude-haiku-4-5` on Gateway; the quick model on a custom endpoint) |
| `BOT_MEMORY_EMBEDDINGS` / `BOT_MEMORY_EMBEDDING_MODEL` | `off` ranks lessons by words only; the model that embeds them otherwise (`openai/text-embedding-3-small`, on Gateway only) |
| `BOT_PUBLIC_URL` | the address the world reaches this deployment at, for OAuth redirect URIs and the sitemap; Vercel supplies its own |
| `BOT_UPDATE_CHECK` | `off` stops the console asking GitHub whether a newer version is out |
| `BOT_VERSION` | the version shown and compared when `package.json` is not shipped with the build |
| `BOT_CONSOLE_TOKEN` / `BOT_CONSOLE_TOKENS` | console passwords, each bound to a workspace |
| `BOT_TICK_CRON` | the watchdog's schedule; daily by default |
| `BOT_STANDUP_CRON` / `BOT_STANDUP_ROOM` | when the daily standup runs (`0 13 * * 1-5`, in UTC) and where it posts: HQ's `desk` by default, or a Bot's room (`bot-<id>`) |
| `BOT_SANDBOX_ALLOW_DOMAINS` / `BOT_BROWSER_ALLOWED_DOMAINS` | fence the computer and the browser |
| `BOT_BROWSER_PAGE_CHARS` / `BOT_BROWSER_SETTLE_MS` | how much of a page a Bot reads per look (`8000`) and how long it lets the page settle first (`300`) |
| `BOT_EMAIL_WEBHOOK` / `BOT_EMAIL_WEBHOOK_TOKEN` | where approved email goes, and the bearer token sent with it; unset returns drafts. The relay must follow the contract below |
| `BOT_EMAIL_WEBHOOK_TIMEOUT_MS` | how long one relay request may take before its outcome counts as unknown (`30000`) |

### Outbound email relay

`send_email` POSTs each approved email to `BOT_EMAIL_WEBHOOK` (with
`Authorization: Bearer $BOT_EMAIL_WEBHOOK_TOKEN` when set):

```
POST $BOT_EMAIL_WEBHOOK
Idempotency-Key: action_<32 hex>
Content-Type: application/json

{"actionId":"action_<32 hex>","to":["…"],"cc":[],"subject":"…","text":"…","jobId":"job_…"}
```

Every send is first recorded in an action ledger (`agent/lib/actions.ts`,
`actions/<workspace>/<actionId>.json`). The action id is derived from the job,
the run, and a hash of exactly this payload, so a replayed step finds the first
attempt's record and returns its receipt instead of sending again, and any
change to the email is a new action that needs its own approval.

Bot still delivers **at least once** toward the relay: if the relay accepts a
request and its reply is lost, Bot cannot tell. So the relay must:

- **Dedupe on `Idempotency-Key`.** A repeated key must not send a second email;
  answer it with the original result. Keep keys at least as long as a job can
  run (a day is plenty).
- **Answer 2xx only once the email is accepted**, with a JSON body carrying its
  receipt: `{"id": "<provider message id>", "status": "queued"}` (`messageId` or
  `receiptId` are read too). Bot stores it on the action.
- **Answer 4xx only when nothing was sent and nothing will be**: Bot records the
  action as failed and does not retry it (`429` is the exception: retried under
  the same key on the next call).
- Expect a `5xx`, `408`, `409`, a timeout (`BOT_EMAIL_WEBHOOK_TIMEOUT_MS`,
  30s) or a dropped connection to be read as **delivery unknown**: Bot never
  resends those on its own and tells the Bot to report the email as possibly
  sent, so a person can check the relay's log.

### The Bots' shell

A Bot's `bash`, `read_file` and `write_file` (and HQ's) run on the computer as
an unprivileged `bot` user, not the user the browser runs as: they cannot read
the browser's profiles, the team's sign-ins or the gateway key, cannot type
into a screen, and cannot connect to Chrome's DevTools, VNC or agent-browser's
stream. So a Bot cannot drive the browser around the approval gate from its
shell. The network fence is iptables where the computer allows it (Vercel
Sandbox) and Landlock otherwise (Docker, Linux 6.7+). Under iptables the shell
may connect to this machine only on an allowlist of ports (web, DNS, ssh, git,
common dev servers) and to the internet on any. Landlock sees ports, not
addresses, so it closes the screens' ports and the kernel's ephemeral range
(where agent-browser's stream and other unnamed listeners land) everywhere and
leaves every other port open. `BOT_SHELL_TCP_PORTS` adds ports to the allowlist
(`5432,6379`), and under Landlock reopens ports inside the ephemeral range.
Each command carries its run as a group of its own, so cancelling a job kills
every process its run started, including ones it left running in the
background. A computer that can have neither fence refuses the shell rather
than run it unfenced;
`BOT_SHELL_ISOLATION=off` instead runs it as the browser's user with every
command waiting for approval. `bot-computer status` reports the mode as
`shell`.

## Development

```bash
npm run dev          # console and agent together
npm run agent:dev    # the agent alone, with eve's terminal UI
npm test             # vitest over tests/: store, models, pricing, search, access, handovers
npm run typecheck && npm run build
npm run reset        # back to zero: threads, roster, jobs, memory; --computer for a fresh machine too
```

Schedules do not fire under `npm run dev`; trigger the watchdog with
`curl -X POST localhost:3000/eve/v1/dev/schedules/tick`. A thread started under
the dev server cannot continue under `npm start`; the console offers Start over.

```
agent/                      HQ: agent.ts, instructions.md, tools/, schedules/, memory/
agent/subagents/teammate/   the Bot that does the work: its tools and browser
agent/lib/                  jobs, board, store drivers, computer, pricing, search
agent/channels/ops.ts       the console API
src/console/                the console
scripts/                    setup, build, start, and the Docker wrapper for Chrome's sandbox
tests/                      vitest
```

Swapping storage means implementing four methods in `agent/lib/store/`.

### A second opinion on small decisions

With an AI Gateway key, Bot can ask [Jev](https://vercel.com/ai-gateway/models/jev)
the questions that are decisions rather than writing: is this page a sign-in
wall, does this result actually meet the brief. It answers as a probability,
priced per input token, and today it decides nothing — each answer is filed
next to what the system did anyway:

```bash
npm run jev:report          # what Jev would have decided, against what happened
```

Turn it off with `BOT_JEV=off`. It is off on its own wherever the Gateway
cannot be reached, so a standalone server on your own models never depends on
it.

### Are the Bots getting better

Every change is supposed to make jobs finish more often, with fewer
interruptions. That is measurable from what the Bots already record:

```bash
npm run metrics              # verified vs recovered closes, interruptions, how long a job takes
npm run metrics -- --days 7
```

Run it before and after a change, on the same kind of work. What a job cost
is on the job itself and in its Bot's panel, as the provider priced it; the
report leaves it out rather than average numbers from different models.

### Bots testing Bots

`npm test` covers the pure parts. The things that actually break — a job that
closes without doing the work, an approval that does not hold, a cancelled job
that comes back — need a running deployment, so there is a suite that drives
one over its own console API:

```bash
QA_URL=https://staging.example QA_TOKEN=… npm run qa    # free, no model calls
QA_JOBS=1 … npm run qa                                  # also runs real jobs
```

It hires bots, writes memory and (with `QA_JOBS=1`) runs jobs, so point it at a
deployment with its own computer and its own data, never at the one you work
in. Failures are written to `.qa/` with what was expected and what the
deployment actually answered.

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
- Delivery is at-least-once. Anything a Bot does outwardly should be idempotent
  or gated on approval.

## License

MIT. See [LICENSE](LICENSE).
