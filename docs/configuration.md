# Configuration

Everything is optional except a model credential. `.env.example` documents all
of it; these are the ones that matter.

## Models

| Variable | Does |
| --- | --- |
| `AI_GATEWAY_API_KEY` | model access on Vercel (or link the project and use OIDC) |
| `BOT_MODEL_BASE_URL` / `BOT_MODEL` / `BOT_MODEL_API_KEY` | your own OpenAI-compatible endpoint and the model used everywhere on it |
| `BOT_MODEL_QUICK` / `BOT_MODEL_STANDARD` / `BOT_MODEL_DEEP` | the model at each effort level; HQ routes between the last two |
| `BOT_HQ_MODEL` | pin HQ to one model |
| `BOT_MODEL_PRICES` | `model=in/out` USD per million tokens, so spend caps hold off Gateway; OpenRouter is read automatically |
| `BOT_JEV` / `BOT_JEV_MODEL` / `BOT_JEV_CONFIDENCE` | the decision model behind memory and the browser gate; `off` disables it (see [Development](development.md#a-second-opinion-on-small-decisions)) |
| `BOT_ZDR` | `1` asks AI Gateway for Zero Data Retention on every call: only providers with a no-retention agreement serve it (Pro and Enterprise; see [Safety](safety.md#data-controls)) |
| `BOT_INFERENCE_REGION` | `us` keeps inference in that region; Gateway fails a call it cannot serve there rather than run it elsewhere |

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
| `BOT_VERSION` | the version shown and compared when `package.json` is not shipped with the build |
| `BOT_TICK_CRON` | the watchdog's schedule; daily by default |
| `BOT_TICK_ON_START` | `off` stops a standalone server sweeping for stranded jobs a minute after it starts |
| `BOT_WORKFLOW_WORLD` | a shared Workflow world package for a standalone server, such as `@workflow/world-postgres` (with `WORKFLOW_POSTGRES_URL`), so conversations survive rebuilds; experimental, see `docs/decisions/0002-workflow-world.md` |
| `BOT_BUILD_ID` | overrides the build id leases are stamped with (see `docs/safety.md`, run fencing) |
| `BOT_SKIP_SANDBOX_PREWARM` | `1` makes `npm run build` skip preparing the computer's sandbox snapshot, for a build that only checks the code (CI without Vercel credentials); a build you deploy needs it, since a production server will not prepare a missing snapshot |
| `BOT_QA` | `1` opens the QA suite's fault routes (crash a job's run, replace the computer) on this deployment; leave unset in production |
| `BOT_STANDUP_CRON` / `BOT_STANDUP_ROOM` | when the daily standup runs (`0 13 * * 1-5`, in UTC) and where it posts: HQ's `desk` by default, or a Bot's room (`bot-<id>`) |

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
