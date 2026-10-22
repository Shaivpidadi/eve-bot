# Configuration

Everything is optional except a model credential. Most of it is set in the console, on the **Settings** page; the
environment variables below are the defaults until it is, and `.env.example` documents every one.

## Settings

The gear in the console's sidebar opens Settings, by area: Spend, Models, Team computer, Browser, Web search, Memory &
decisions, Email, Background work, Team, Server, Data controls, Engines and Updates. Each area shows only what applies
where this copy runs: AI Gateway's controls with Gateway models, your provider's with yours, Vercel's computer's on
Vercel. Each setting says where its value comes from (changed here, from
`.env`, or the default), and Reset goes back to the environment's.

- **Who changes what.** Settings for the whole deployment (the computer, the browser, email, data controls) are its
  owner's:
  - the holder of `BOT_CONSOLE_TOKEN`;
  - on Vercel with Vercel Authentication, whoever signs in to the production deployment;
  - locally with no token, the developer.

  `BOT_CONSOLE_TOKENS` holders are tenants: they see and change their own workspace's settings (timezone, first
  Bot's name, models, reasoning, memory), and may only set its budget below the deployment's.
- **When a change applies.**
  - Most apply within about 30 seconds, on every instance.
  - The computer's settings apply when a session next gets the computer. On Vercel the allowed sites and timeout are
    pushed to the running machine; CPUs and a drive apply from its next session. On Docker they apply from the
    container's next start.
  - Cost and token caps, where the computer runs, your model provider, the search service, the schedules, the
    engines and where conversations are kept are fixed when the agent is built. `npm run build` and
    `npm start` lay the saved values over the environment and record what they used, `npm start` rebuilds when they
    changed, and on Vercel they apply with the next deploy. Until then the page marks the change as waiting.
- **Secrets** (the email webhook's token, your provider's and search's API keys, the Postgres address) are sealed with
  the computer's key and never shown again. API keys are read on each call, never built in; the Postgres address is
  handed to a standalone server when it starts. An export
  without secrets leaves all saved settings out.
- **Locking.** `BOT_SETTINGS_EDITABLE=off` shows the page without letting anyone change it, so only the environment
  applies. `BOT_MODELS_EDITABLE=off` does the same for models alone.
- **Environment only.** These stay in the environment, because the console needs them before it can run, or because
  changing them from a web page would be unsafe:
  - a first model credential for the server to start with (`AI_GATEWAY_API_KEY`, or your provider in
    `BOT_MODEL_BASE_URL` and `BOT_MODEL`); Settings → Models can change the provider afterwards;
  - the store (`BOT_STORE`, `BLOB_READ_WRITE_TOKEN`, `BOT_DATA_DIR`);
  - sign-in (`BOT_CONSOLE_TOKEN`, `BOT_CONSOLE_TOKENS`, `BOT_CONSOLE_AUTH`, `BOT_CONSOLE_OPEN`);
  - the computer's name and key (`BOT_COMPUTER_NAME`, `BOT_COMPUTER_KEY`), which name its drive and seal secrets;
  - shell isolation (`BOT_SHELL_ISOLATION`);
  - on Vercel, whether the background worker runs at all (`BOT_WORKER`). Settings can pause it and set its pace.

## Models

The console's **Models** page picks the model for each role, on AI Gateway or on your own OpenAI-compatible provider
(set in Settings → Models, or `BOT_MODEL_BASE_URL`):
- **HQ:** the conversation.
- **Bots:** standard, quick and deep jobs.
- **Helper:** memories, a new Bot's hello, and team suggestions.

It lists Gateway's models, free ones first and then paid ones cheapest first, with prices and whether each can see
screenshots. You can also type any `provider/model` id Gateway serves. **Free models only** puts every role on a free
model; a role not set to one runs on the free model that can see screenshots (`minimax/minimax-m3.1-flash` today).

On your own provider the page lists what it serves (its `/models`), and you can type any name it takes, such as
`qwen3:8b`. Free models only is an AI Gateway choice and is not offered there. Choices are kept per provider: those
made for AI Gateway never reach your provider, and the other way round. Jev's second opinions run there too, answered
by your provider's quick model (or `BOT_JEV_MODEL` there), without Jev's calibrated probabilities; and memory by
meaning uses your provider's embedding model once one is named (`BOT_MEMORY_EMBEDDING_MODEL`, such as
`nomic-embed-text` on Ollama). eve's own web search and Zero Data Retention stay AI Gateway's; Settings → Web search
picks a search service for your provider.

Choices are saved per workspace and win over the variables below, which stay the defaults. A change applies from
HQ's next message and each job's next run, within about 30 seconds, and a running job keeps its model. The page warns
when a choice will hurt:
- a model that can't see screenshots on a Bots role, since browser steps then fail;
- a helper that can't answer in a fixed format, since memories may not save;
- a model Gateway no longer lists.

While `BOT_ZDR` is on, it refuses models without Zero Data Retention. With `BOT_MODEL_BASE_URL` set, the page only
shows the endpoint's models.

| Variable | Does |
| --- | --- |
| `AI_GATEWAY_API_KEY` | model access on Vercel (or link the project and use OIDC) |
| `BOT_MODEL_BASE_URL` / `BOT_MODEL` / `BOT_MODEL_API_KEY` | your own OpenAI-compatible endpoint and the model used everywhere on it |
| `BOT_MODEL_QUICK` / `BOT_MODEL_STANDARD` / `BOT_MODEL_DEEP` | the model at each effort level; HQ routes between the last two |
| `BOT_HQ_MODEL` | HQ's default model |
| `BOT_TEAMMATE_MODEL` / `BOT_MEMORY_MODEL` | one default model for every Bot job / the helper's default model |
| `BOT_MODELS_EDITABLE` | `off` makes the Models page read-only, for a deployment whose console tokens go to people who should not choose what its Gateway key pays for |
| `BOT_MODEL_PRICES` | `model=in/out` USD per million tokens, so spend caps hold off Gateway; OpenRouter is read automatically |
| `BOT_JEV` / `BOT_JEV_MODEL` / `BOT_JEV_CONFIDENCE` | the decision model behind memory and the browser gate; `off` disables it (see [Development](development.md#a-second-opinion-on-small-decisions)) |
| `BOT_ZDR` | `1` asks AI Gateway for Zero Data Retention on every call: only providers with a no-retention agreement serve it (Pro and Enterprise; see [Safety](safety.md#data-controls)) |
| `BOT_INFERENCE_REGION` | `us` keeps inference in that region; Gateway fails a call it cannot serve there rather than run it elsewhere |

Free models are fine for trying things, with limits (checked 19 Oct 2026). On AI Gateway,
`minimax/minimax-m3.1-flash` costs nothing and does everything here:
- it calls tools;
- it sees screenshots, so the browser works;
- it extracts memories.

A full job ran on it end to end. Other free models fall short:
- `nvidia/nemotron-3.5-lightning-free`, `stealth/cat-jam`, `stealth/glyph-cluster`, `poolside/laguna-s-2.1-free`
  and `reflection/beam-free` take no images, so browser steps fail (the thread says so).
- Those tested couldn't extract memories.

Free models offer no Zero Data Retention, and a stealth model can go away without notice; the Models page shows
what is free today. Vercel's Token Pass (Pro, early access) is the cheaper
paid option: $30 buys $80 of usage on the models it covers.

## Spend

| Variable | Does |
| --- | --- |
| `BOT_HQ_COST_LIMIT_USD` / `BOT_JOB_COST_LIMIT_USD` | per-session spend caps (`10` / `5`) |
| `BOT_BUDGET_MONTHLY_USD` / `BOT_BUDGET_DAILY_USD` | workspace spend limit per UTC month / day; unset = no limit, spend still tracked |
| `BOT_COMPUTER_USD_PER_HOUR` / `_PER_CPU_HOUR` / `_PER_GB_HOUR` | the computer's rate from your Vercel plan, so its runtime counts on the budget; unset = unpriced |

## The computer, search, and the browser

| Variable | Does |
| --- | --- |
| `BOT_COMPUTER` | `vercel` (default) or `local` |
| `BOT_COMPUTER_IMAGE` | where the computer's software comes from: unset, local builds `agent/sandbox/Dockerfile` and Vercel installs it on first boot; a Vercel Container Registry image built from that Dockerfile (`vercel vcr build docker agent/sandbox --push`, linux/amd64) or any OCI image locally; `default` for eve's base image and the first-boot install |
| `BOT_COMPUTER_DRIVE` / `BOT_COMPUTER_DRIVE_GB` | Vercel only: `on` keeps the team's work and browser profiles on a [Vercel Drive](https://vercel.com/docs/vercel-sandbox/drives) named after the computer, so a lost machine loses nothing and its replacement mounts the same drive (sign-ins included); backups then run hourly as a copy kept elsewhere. Size in GB, Vercel's default when unset. A machine from before mounts it from its next start |
| `BOT_COMPUTER_LOCAL_BIND` | where a local computer's live view is published; `127.0.0.1` by default |
| `BOT_SEARCH_PROVIDER` / `BOT_SEARCH_URL` / `BOT_SEARCH_API_KEY` | web search on your own endpoint: `searxng`, `brave`, `tavily`, `exa` |
| `BOT_SANDBOX_ALLOW_DOMAINS` / `BOT_BROWSER_ALLOWED_DOMAINS` | fence the computer and the browser |
| `BOT_BROWSER_PAGE_CHARS` / `BOT_BROWSER_SETTLE_MS` | how much of a page a Bot reads per look (`8000`) and how long it lets the page settle first (`300`) |
| `BOT_BROWSER_GUARD_MS` | how long after a click the network guard watches what the page sends (`1200`) |
| `BOT_SHELL_TCP_PORTS` / `BOT_SHELL_ISOLATION` | extra ports the shell may reach (`5432,6379`); `off` runs it unfenced with every command gated (see [The Bots' shell](#the-bots-shell)) |

## Memory

| Variable | Does |
| --- | --- |
| `BOT_MEMORY_FLOOR` | how sure Jev must be before something is remembered (`0`–`1`; defaults to `BOT_JEV_CONFIDENCE`) |
| `BOT_MEMORY_MODEL` | the model that reads exchanges for memories (`anthropic/claude-haiku-4-5` on Gateway; the quick model on a custom endpoint) |
| `BOT_MEMORY_EMBEDDINGS` / `BOT_MEMORY_EMBEDDING_MODEL` | `off` ranks lessons by words only; the model that embeds them otherwise (`openai/text-embedding-3-small`, on Gateway only) |

## Console, schedules, and deployment

| Variable | Does |
| --- | --- |
| `BOT_CONSOLE_TOKEN` / `BOT_CONSOLE_TOKENS` | console passwords, each bound to a workspace |
| `BOT_PUBLIC_URL` | the address the world reaches this deployment at, for OAuth redirect URIs and the sitemap; Vercel supplies its own |
| `BOT_EXPORT` | `on` lets the console download the signed-in workspace as an export file (`GET /bot/v1/export`; add `?secrets=1` for connectors) |
| `BOT_UPDATE_CHECK` | `off` stops the console asking GitHub whether a newer version is out |
| `BOT_UPDATE_TOKEN` | a fine-grained GitHub token for a Deploy-button copy (Actions, Contents and Workflows, read and write), so **Update now** updates it from the console; best saved in Settings (Updates), sealed. See [updating.md](updating.md) |
| `BOT_DEPLOY_HOOK` | a Vercel deploy hook URL (Settings, Git, Deploy Hooks in Vercel), so **Rebuild now** applies a saved setting that waits for a build (the spend caps, where the computer runs, the engines) from the console; best saved in Settings (Updates), sealed. Only an `api.vercel.com` deploy hook is ever called |
| `BOT_VERSION` | the version shown and compared when `package.json` is not shipped with the build |
| `BOT_TICK_CRON` | the watchdog's schedule; daily by default |
| `BOT_WORKER` / `BOT_WORKER_EVERY_SECONDS` | standalone: on unless `off` (`npm start` runs it). Vercel Pro, production, once the worker is declared (see [The background worker](#the-background-worker)): `on` makes it ask the app for the watchdog's work every `30` seconds, so due work, teammates' notes and idle browsers move with no console open. The Usage page shows its last pass. Settings can pause it or change its pace without a redeploy |
| `BOT_TICK_ON_START` | `off` stops a standalone server sweeping for stranded jobs a minute after it starts |
| `BOT_WORKFLOW_WORLD` | a shared Workflow world package for a standalone server, such as `@workflow/world-postgres` (with `WORKFLOW_POSTGRES_URL`), so conversations survive rebuilds; experimental, see `docs/decisions/0002-workflow-world.md` |
| `BOT_BUILD_ID` | overrides the build id leases are stamped with (see `docs/safety.md`, run fencing) |
| `BOT_SKIP_SANDBOX_PREWARM` | `1` makes `npm run build` skip preparing the computer's sandbox snapshot, for a build that only checks the code (CI without Vercel credentials); a build you deploy needs it, since a production server will not prepare a missing snapshot |
| `BOT_QA` | `1` opens the QA suite's fault routes (crash a job's run, replace the computer) on this deployment; leave unset in production |
| `BOT_STANDUP_CRON` / `BOT_STANDUP_ROOM` | when the daily standup runs (`0 13 * * 1-5`, in UTC) and where it posts: HQ's `desk` by default, or a Bot's room (`bot-<id>`) |

## Bots on Claude Code or Codex (experimental, off)

A Bot can run its jobs on Claude Code or Codex instead of eve, through Vercel's
[`durable-harness`](https://vercel.com/blog/making-every-harness-durable). Every
Bot runs on eve unless you choose otherwise: when the owner turns an engine on,
the hire dialog asks what a new Bot runs on (eve preselected), and a Bot's
profile can move it. HQ can do the same when asked.

Turn them on in the console: **Settings → Engines**, owner only. Those
settings apply with the next build, as the variables below do: on Vercel,
press **Rebuild now** beside the saved setting once a deploy hook is saved
(**Settings → Updates**; make the hook in Vercel under Settings, Git, Deploy
Hooks), or redeploy; locally, the next `npm start` rebuilds. The variables
still work, and a saved setting wins over them. It is an experiment, and
the library is still `0.0.x`: see `docs/plan/harness-engines.md` for what is
built, what is not, and what the live checks showed.

| Variable | Does |
| --- | --- |
| `BOT_ENGINES` | `claude-code`, `codex`, or both (`claude-code,codex`) turns those engines on for this deployment (or Settings → Engines). Read at build: unset (the default), the build is exactly as without the feature |
| `BOT_CLAUDE_CODE_MODEL` | the AI Gateway model a Claude Code Bot runs on (an `anthropic/…` model); the library's default when unset |
| `BOT_CODEX_MODEL` | the AI Gateway model a Codex Bot runs on (one that speaks OpenAI's Responses API); `openai/gpt-5.4-mini` when unset |
| `BOT_ENGINE_BUILTINS` | `1` gives these Bots the CLI's own tools: a shell and file editing (Claude Code's Bash, Read, Edit and Write, never WebFetch; Codex's shell and `apply_patch`), in the job's Sandbox on its own scratch Drive. Off when unset |
| `BOT_ENGINE_NETWORK` | the Sandbox's outbound network: unset is none at all, `allow-all` is everything, a comma list of domains (`registry.npmjs.org,*.github.com`) is only those. Model calls never need it |

**Billing.** Both engines make their model calls through AI Gateway, with the
same `AI_GATEWAY_API_KEY` (or OIDC token) eve uses, so they are billed as
Gateway credits, like every other Bot. A Claude Pro/Max or ChatGPT
subscription is not used, and cannot be: the library has no way to sign in
with one. On a standalone server, the plan engines below can. Each job also uses a Vercel Sandbox and a Drive of its own, billed
by Vercel as Sandbox time and storage.

What such a Bot gets, and does not:

- Its own Vercel Sandbox for each job, with no network unless
  `BOT_ENGINE_NETWORK` opens it, deleted when the job ends. Not the team's
  computer: no browser, no shared files.
- Its tools: read the job, log a step, record the result, and propose an
  email, which a person approves or declines in the Bot's thread before
  eve-bot sends it, once.
- The team's connectors, under each connector's gate as for any Bot, read
  live on every call: reads run at once, and whatever the gate would ask
  about appears as a card in the Bot's thread, which eve-bot carries out,
  exactly as shown and once, when a person approves. Under the "all" gate
  every call asks (such a Bot has no eve session for a first-use approval to
  last in), and an approval given before the connector's settings changed
  runs nothing. A shell and file editing only with
  `BOT_ENGINE_BUILTINS=1`; each such call is logged before it runs and never
  re-run after a crash, and Claude Code runs its commands under bubblewrap in
  the VM (a turn fails if that cannot start).
- The job's spend limit (`BOT_JOB_COST_LIMIT_USD`) as a cap the session itself
  enforces, and the workspace budget checked at every look at the job (about
  every 20 seconds): its spend is read from the session's log, charged to the
  job and the Usage page as it goes, and the job stops when the budget runs out.
- Owner's workspace only, and refused where it would drop a data control: with
  `BOT_ZDR` or `BOT_INFERENCE_REGION` set, or on your own model endpoint
  (`BOT_MODEL_BASE_URL`).

**Not on Hobby.** Hobby's Sandbox quota is small, and once it is used up every
new Sandbox waits until the next cycle, the team's computer included. Nothing
in a deployment can tell which plan it is on, so this is on you: leave
`BOT_ENGINES` unset on Hobby.

On a Vercel deployment, each such job's session is in **Agent Runs** too
(the same tracing rule turns it on): its turns, model and tool calls, timing
and spend. Metadata only: no brief, reply or tool input or output is recorded.
A Bot's profile links there; Vercel has no link to one session yet, so open it
from the list.

Locally, sessions run on the local Workflow World (`.workflow-data`), but each
job's Sandbox is still on Vercel, so a local server needs the project's
credentials (`vercel env pull` for a `VERCEL_OIDC_TOKEN`, or `VERCEL_TOKEN`,
`VERCEL_TEAM_ID` and `VERCEL_PROJECT_ID`).

## Bots on Claude Code or Codex with your own plan (standalone, experimental)

On a standalone server whose team computer is local (`BOT_COMPUTER=local`), a
Bot can also run on **Claude Code (your plan)** or **Codex (your plan)**: the
CLI itself, on the team's computer, in the Bot's own folder there, signed in
with your own Claude Pro/Max or ChatGPT plan. No Vercel Sandbox, durable-harness
or AI Gateway is involved, and nothing needs a rebuild: an engine is offered in
the hire dialog as soon as its sign-in is saved in **Settings → Engines**
(owner only, stored sealed).

| Setting | Does |
| --- | --- |
| `BOT_LOCAL_CLAUDE_TOKEN` | Claude Code's sign-in: the token `claude setup-token` prints (your plan), or an Anthropic API key (`sk-ant-api…`, billed per token), or with the address below, that service's key |
| `BOT_LOCAL_CLAUDE_MODEL` / `BOT_LOCAL_CLAUDE_BASE_URL` | the model (`sonnet`, `opus`, or a full name) and, only to send its calls elsewhere (AI Gateway, a proxy), the API address |
| `BOT_LOCAL_CODEX_AUTH` | Codex's sign-in: the contents of `~/.codex/auth.json` after `codex login --device-auth` (your ChatGPT plan). Codex refreshes it while it runs, and the saved copy follows |
| `BOT_LOCAL_CODEX_API_KEY` / `BOT_LOCAL_CODEX_BASE_URL` / `BOT_LOCAL_CODEX_MODEL` | instead of a plan, a key billed per token, for OpenAI or another address that speaks the Responses API; and the model |
| `BOT_ENGINE_TOOLS_URL` | where the computer's container reaches this server's tools. Docker Desktop, OrbStack and Colima reach it as `host.docker.internal` on its own port, the default; on Docker on Linux set it (`http://172.17.0.1:3000/bot/v1/engine/mcp`) |

How it runs: the first job installs the pinned CLI once into
`/workspace/.engines` (left out of the computer's backups). Each job starts the
CLI in the background as the computer's `bot` user, under the same network
fence as a Bot's own shell, and eve-bot reads its event stream about every 20
seconds: its words appear in the Bot's thread and the job ends with its turn.
Its tools are eve-bot's (read the job, log a step, record the result, propose
an email, the team's connectors under their gates), reached over MCP with a
secret that is good for that run only and forgotten when it stops. The CLI's
own shell and file tools only with `BOT_ENGINE_BUILTINS=1`.

What it costs: a plan's turns use your plan's limits and are charged $0 here
(they still count as the job's turns). With a key, Claude Code's own report of
what the turn cost is charged to the job and the Usage page; Codex reports
tokens but no cost, so a Codex turn on a key is not charged here, and the
spend caps do not see it: watch that key's own usage page. Owner's workspace only. Use your own plan
for your own Bots: a plan's terms may not allow sharing it with others.

## Observability: Vercel Agent Runs

On a Vercel deployment, every HQ, Bot and job session appears in **Agent
Runs**, under your project's Observability tab: the conversation, each turn,
tool calls, model, tokens, cost and timings. It needs a tracing rule on the
project (**Settings → Tracing**, rate 100%, or `vercel traces config set
production 100`); `eve deploy` creates new projects with one. It is billed as
span units, cents a month at this team's size, and Hobby includes a million a
month. Runs are kept 30 days. Locally, `eve dev` keeps its own traces.

Agent Runs reads each session's record from Vercel Workflow, where eve already
keeps a Vercel deployment's conversations so they survive restarts and
deploys. So the conversation is on Vercel whether or not tracing is on, and no
app setting hides it from Agent Runs. To keep conversations off Vercel, run
standalone with your own Postgres world (`BOT_WORKFLOW_WORLD`, above).

## Journal and rewind

There are no settings. Each job keeps the first 20 and last 180 lines of its
journal, and up to 10 rewind points (the first and the latest nine), taken
when a run starts, at each decision, and before an email. A rewind point
holds only the job's own files.

## Email

| Variable | Does |
| --- | --- |
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

## The Bots' shell

A Bot's `bash`, `read_file` and `write_file` (and HQ's) run on the computer as
an unprivileged `bot` user, not the user the browser runs as: they cannot read
the browser's profiles, the team's sign-ins or the gateway key, cannot type
into a screen, and cannot connect to Chrome's DevTools, VNC or agent-browser's
stream. So a Bot cannot drive the browser around the approval gate from its
shell.

The network fence is iptables where the computer allows it (a container with
`NET_ADMIN`), nftables where the kernel lacks iptables' owner match (Vercel
Sandbox, which also lacks Landlock and IPv6 filtering, so IPv6 is switched off
there), and Landlock otherwise (Docker, Linux 6.7+). Under iptables and
nftables the shell may connect to this machine only on an allowlist of ports
(web, DNS, ssh, git, common dev servers) and to the internet on any. Landlock
sees ports, not addresses, so it closes the screens' ports and the kernel's
ephemeral range (where agent-browser's stream and other unnamed listeners
land) everywhere and leaves every other port open. `BOT_SHELL_TCP_PORTS` adds
ports to the allowlist (`5432,6379`), and under Landlock reopens ports inside
the ephemeral range.

Each command carries its run as a group of its own, so cancelling a job kills
every process its run started, including ones it left running in the
background. A computer that can have neither fence refuses the shell rather
than run it unfenced; `BOT_SHELL_ISOLATION=off` instead runs it as the
browser's user with every command waiting for approval. `bot-computer status`
reports the mode as `shell`.

## The background worker

On a standalone server, `npm start` is the worker: every 30 seconds it asks the agent for the watchdog's work, with a
secret it makes for each start, so due work, routines, teammates' notes and the outbox move with no console open.
**Settings → Background work** pauses it or changes its pace; `BOT_WORKER=off` leaves the work to the console's polls
and the daily tick. It also gives the agent its own address (`BOT_PUBLIC_URL`, unless you set one). The rest of this
section is about Vercel.

On Vercel, `daemon/` holds a small worker that asks the app for the watchdog's work every 30 seconds with its OIDC token
(`POST /bot/v1/internal/tick`), so due work, teammates' notes and idle browsers move with no console open. Without
it the same work happens on the console's polls, the daily cron and the server's own passes; it is only slower when
nobody has the console open.

It is not declared by default. A [Vercel Daemon](https://vercel.com/docs/daemons) runs around the clock, and on Pro it
is billed for its provisioned memory whether it works or not; on Hobby it would use up Vercel Blob's 2,000 monthly
operations within hours (about 3 a pass), after which Vercel blocks the store for 30 days. To run it on Pro, add it to
your copy's `vercel.json`, at the smallest size, and set `BOT_WORKER=on`:

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "framework": "nextjs",
  "daemons": {
    "worker": {
      "root": "daemon/",
      "entrypoint": "Dockerfile",
      "instances": { "iad1": 1 },
      "resources": { "requests": { "memory": "1Gi" } },
      "terminationGracePeriodSeconds": 30
    }
  }
}
```

Daemons run only in production. To stop it, set `instances` to `{ "iad1": 0 }` or remove the block; leaving it
declared with `BOT_WORKER` off still keeps one idle instance (and its memory) running.

## Notifications

The console installs as an app (Chrome, Edge, Safari; on iPhone and iPad from Share → Add to Home Screen, which is
also the only place iOS lets it notify). Each person turns notifications on per device in **Settings →
Notifications**, and chooses what reaches them:

- **A Bot needs you:** an approval, a question, a job waiting on you. Sent at once, even in quiet hours.
- **A job ends:** finished, or failed for good.
- **News from Bots:** what HQ or a Bot sends with its `notify` tool, such as a routine's finding. At most 3 an hour and
  10 a day per workspace, and the same news (by key) once a day.
- **Quiet hours**, in the workspace's timezone (22:00–08:00 unless changed): only what needs you comes through. The rest
  is held, and three or more held for a device arrive as one "While you were away". Held notifications go out with
  the first pass after quiet hours: the console opening, a Bot at work, or the background worker if it is declared.
- **Only when I'm away:** in Chrome, nothing but what needs you while the console is focused. Safari and iPhone always
  show them (Safari takes push away from sites whose pushes show nothing).

Nothing to configure on the server: the deployment makes its own Web Push keys the first time they are needed and
keeps the private one sealed. Pressing a notification opens the Bot's thread; nothing is approved from one.

