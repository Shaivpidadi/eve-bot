# Bot

A team of always-on AI teammates. Each one has its own computer, works inside the
apps you already use, and keeps going after you close the laptop — coming back
only when something needs your approval.

This is a working replica of the Grok Bot product idea, built on Vercel's
[eve](https://eve.dev) agent framework: eve for the durable runtime, Vercel
Sandbox for each bot's computer, [agent-browser](https://github.com/vercel-labs/agent-browser)
for its browser, and Vercel Blob for memory and persistent data.

```
you ──▶ HQ ──assign──▶ job queue ──dispatch──▶ teammate ──▶ browser + shell + files
         │                  ▲                      │
         │                  └── every minute ───────┤
         └──◀ result, or an approval you must sign ─┘
```

## What is actually here

| The claim | How it works |
| --- | --- |
| **A computer of its own** | Each teammate gets an isolated Linux microVM (Vercel Sandbox) with a persistent `/workspace`, a shell, and real binaries. `agent/subagents/teammate/sandbox/`. |
| **Works inside apps, no API needed** | A real Chromium in the sandbox, driven through accessibility snapshots with stable `@ref` handles. `agent/subagents/teammate/tools/page_*.ts`. |
| **Keeps working 24/7** | Jobs run as durable Workflow runs. A run survives redeploys and crashes, and a bot waiting on a human holds no compute. `agent/tools/run_job.ts`. |
| **Only comes back for approval** | Irreversible actions are gated on a person (`approval: always()`), and a deliverable can require sign-off that stays pending for a day. Answer one with `POST /bot/v1/rooms/:room/respond` — a plain message starts a new turn instead of resolving the request. |
| **Message them like a colleague** | One HTTP channel with rooms; each room is a durable conversation. A single-file console at `/bot` renders the roster, the work, and the live feed. `agent/channels/ops.ts`. |
| **They remember and get sharper** | Three memory slots (per-person, per-workspace, per-craft) plus a per-bot playbook replayed into every brief. |
| **Finishes end to end** | Every job carries explicit success criteria, the bot must verify its own work, and results record whether they were verified. |

## Quickstart

Requires **Node 24+**.

```bash
npm install
cp .env.example .env.local     # add AI_GATEWAY_API_KEY
npm run dev                    # terminal UI, server on :2000
```

Then open **http://localhost:2000/bot** — the console: your roster on the left,
the desk conversation in the middle, work and live activity on the right.
Approvals appear as cards you answer in place. Or stay in the terminal UI; both
drive the same durable sessions.

Then talk to HQ:

```
Hire a bot called Ava who handles inbound sales follow-up. She should be warm
and brief, and never promise a discount.

Ava: pull yesterday's demo list from the CRM and draft a follow-up for each one.
Don't send anything — I'll review the drafts.
```

HQ hires Ava, writes a job with success criteria, and starts it in the
background. Ava opens the CRM in her browser, works the list, logs each step,
saves a screenshot of what she saw, and comes back with drafts. Ask HQ
`what happened while I was out?` and it reads the feed back to you.

`eve dev` does not fire schedules. Trigger the dispatcher by hand while you
iterate:

```bash
curl -X POST http://localhost:2000/eve/v1/dev/schedules/tick
```

## Deploy

```bash
npx vercel link
npx eve add memory/file        # provisions the private Blob store for memory
npx vercel blob store add bot-store   # storage for the roster, jobs, and feed
npx eve deploy
```

On Vercel the schedules become Cron Jobs, the sandboxes become Vercel Sandboxes,
and both stores authenticate with OIDC — no tokens in your environment. Cron
expressions are evaluated in UTC.

## The console

`GET /bot` serves a dependency-free page — no second server, no build step. It
polls `/bot/v1/state` for the roster, jobs, and feed, streams the desk session's
NDJSON for live messages and tool calls, and posts answers to `/respond` when a
bot asks for sign-off. Pass `?room=ops` to watch a different room.

## Talking to it over HTTP

`BOT_CONSOLE_TOKEN` protects these; unset means open, which is fine locally. Port
2000 is the `eve dev` default.

```bash
# Say something to a room (creates or resumes that room's durable session)
curl -X POST localhost:2000/bot/v1/rooms/desk/messages \
  -H 'content-type: application/json' \
  -H 'x-bot-user: you@example.com' \
  -d '{"message":"Who is on the team?"}'

# Answer a pending approval or question (requestId comes off the stream)
curl -X POST localhost:2000/bot/v1/rooms/desk/respond \
  -H 'content-type: application/json' \
  -d '{"responses":[{"requestId":"<id>","optionId":"approve"}]}'

# Follow a session live (NDJSON)
curl -N localhost:2000/bot/v1/sessions/<id>/stream

# Everything a dashboard needs: roster, jobs, activity
curl localhost:2000/bot/v1/state
```

## Layout

```
agent/
├── agent.ts                    HQ: the teammate you message
├── instructions.md             how HQ behaves
├── channels/ops.ts             rooms, streaming, state, approvals, handoff
├── channels/console.html       the console, embedded at compile time
├── schedules/tick.ts           the minute heartbeat that makes bots always-on
├── schedules/standup.ts        a daily report, written like a person would
├── hooks/audit.ts              durable record of approvals and failures
├── memory/profile.ts           how this operator likes things done
├── memory/team.ts              conventions shared across the workspace
├── skills/running-the-team.md  loaded when HQ writes a brief
├── tools/                      hire_bot, assign_job, run_job, job_status, …
├── lib/                        persistence, job queue, briefs, artifacts
└── subagents/teammate/         the bot that does the work
    ├── agent.ts                its model and spend limit
    ├── instructions.md         verify before you claim
    ├── sandbox/                its computer, and what is seeded into it
    ├── memory/craft.ts         lessons about doing this work well
    ├── skills/web-signin/      how to work inside a web app
    ├── lib/browser.ts          agent-browser, wired into the sandbox
    └── tools/                  browse, page_*, log_progress, save_artifact,
                                learn, send_email, finish_job
```

## How the pieces fit

**Jobs are records, not conversations.** `assign_job` writes a job to durable
storage with a brief, success criteria, a schedule, and a sign-off flag. That
record is the contract: a teammate re-reads it with `job_brief` rather than
trusting the message it was started with.

**The dispatcher is one cron and a compare-and-set.** `tick` runs every minute,
finds due work — including runs whose lease lapsed because a deploy interrupted
them — claims each one atomically, and wakes HQ in that job's room. Overlapping
ticks cannot double-dispatch: the claim is a versioned write, not a flag.

**`run_job` is where the durability lives.** It is a background workflow tool, so
the conversation continues the moment work starts. Inside, it claims the job in a
step, delegates to the teammate, and — if the job needs sign-off — asks a human
and suspends. Nothing is held open while it waits; the run resumes when the
answer arrives, minutes or a day later.

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
| Vercel Blob | on Vercel, or when Blob credentials are set | ETag `ifMatch` — a true compare-and-set across instances |
| Local disk | `eve dev` (`.data/`) | in-process key locking; single-process only |
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
| `BOT_HQ_MODEL` / `BOT_TEAMMATE_MODEL` | HQ runs Sonnet for conversation, teammates run Opus for the work |
| `BOT_STORE` | force `blob`, `fs`, or `memory` |
| `BOT_CONSOLE_TOKEN` | bearer token for the HTTP routes |
| `BOT_SANDBOX_ALLOW_DOMAINS` | firewall the bot's computer to an allow-list |
| `BOT_BROWSER_ALLOWED_DOMAINS` | fence the browser to specific hosts |
| `BOT_EMAIL_WEBHOOK` | where approved email actually goes; unset returns drafts |
| `BOT_HQ_COST_LIMIT_USD` / `BOT_JOB_COST_LIMIT_USD` | per-session spend caps |

## Known limits

- **Browser locally.** With no Docker or microsandbox, eve falls back to a
  simulated shell that cannot run Chromium. Shell and file work still function;
  browser tools need Docker locally, or a deploy.
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
