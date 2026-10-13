# Brain, hands, and runs that outlive their machine

Research notes, 13 Oct 2026. Three properties were put to the project:

1. The brain (the harness) runs outside and drives a separate machine (the hands).
2. A session can move between cloud Linux, a cloud Mac and your own machine
   without losing state.
3. A crash, a deploy or a dead sandbox does not kill the run, and you can
   rewind it.

This note says where the ideas come from, what eve 0.58 already gives us,
what EVE BOT does today, and where the gaps are. It is a reading, not a plan.

## Where the three lines come from

They describe Anthropic's Managed Agents architecture, published as
"Scaling Managed Agents: Decoupling the brain from the hands" (8 Apr 2026).
The design virtualizes three parts behind small interfaces:

| Part | Role | Interface |
| --- | --- | --- |
| Session | an append-only event log, the only durable truth | `getSession(id)`, `getEvents()`, `emitEvent(id, event)` |
| Harness (brain) | the loop that calls the model and routes tool calls; stateless | `wake(sessionId)` starts a fresh one from the log |
| Sandbox (hands) | where tools execute; disposable | `provision({resources})`, `execute(name, input) → string` |

Key sentences: "The harness leaves the container." "The harness is never
made aware of any credentials." "Because the session log sits outside the
harness, nothing in the harness needs to survive a crash." "The harness
doesn't know whether the sandbox is a container, a phone, or a Pokémon
emulator." If a container dies, the harness returns the failure to the model
as a tool error and a fresh container is provisioned; nothing is repaired.
The reported win from provisioning hands only when needed: p50 time to first
token down about 60%, p95 down over 90%.

What the public material does and does not say about each line:

- **Line 1** is the post's thesis, and it is also eve's design (below).
- **Line 2** is not stated anywhere. The post says hands are not coupled to
  brains, so "brains can pass hands to one another", and the product offers
  two environment kinds: Anthropic's cloud sandboxes (Ubuntu 24.04, x86_64)
  and self-hosted sandboxes, where a worker you run on any host with bash
  (the `ant` CLI installs on Linux and macOS) claims sessions from a queue and
  runs each tool call locally. A session is created against one environment;
  the docs show no way to move it to another. What moves is the conversation,
  because it lives in the log; the filesystem is a per-session checkpoint,
  kept 30 days, and a resumed session whose checkpoint is gone starts from a
  fresh sandbox. So "cloud Linux, cloud Mac, your own machine" is a
  consequence of the design, not a documented feature.
- **Line 3**: a harness crash is survived by waking a new harness from the
  log; a dead sandbox becomes a tool error the model retries against a new
  one. "Rewind" is a positional read of the log ("rewinding a few events
  before a specific moment to see the lead up"), not a restore of state.
  Deploys are not discussed.

Sources: the engineering post, the Managed Agents docs (overview, sessions,
session operations, events and streaming, self-hosted sandboxes, cloud
sandbox reference), all read 13 Oct 2026.

## What eve 0.58 gives us

eve's execution model is the same split, with the pieces named differently.

- **Brain outside the hands.** "An eve agent spans two execution
  environments": the agent loop runs as a durable workflow in the app runtime
  (model calls, tools, hooks, connections, credentials), and reaches the
  sandbox only through `ctx.getSandbox()`. "The loop and sandbox have
  decoupled lifetimes: the durable workflow can park or restart
  independently, while the app runtime opens or reuses sandbox compute only
  when code needs it." Credentials never enter the sandbox; brokered network
  access handles the rest. This is line 1, verbatim.
- **The session log.** Every session is one durable workflow on the Workflow
  SDK, checkpointed at step boundaries, with an append-only event stream whose
  events carry stable ids. The stream can be read from any `startIndex`,
  including 0 to rewind, and a negative index reads from the tail. That is
  eve's equivalent of Anthropic's "rewind": a read, not a restore.
- **Crash and deploy.** "Crash the process, hit a timeout, or redeploy
  mid-turn, and the run picks up from the last completed step." Completed
  steps are replayed from the journal; an interrupted step re-runs, so side
  effects must be idempotent. Parked work (approval, OAuth, `sleep`) holds no
  compute. On Vercel a running turn stays on the deployment that started it;
  an idle session is handed to the newest deployment on its next delivery,
  after that deployment validates the checkpoint.
- **Dead sandbox.** eve keeps a reconnect record per durable session. If the
  persisted Vercel sandbox or its snapshot is gone, "eve deletes the unusable
  record and creates a replacement from the current template"; files made
  after creation "are not restored automatically. Persist important artifacts
  outside the sandbox."
- **Where the hands can be.** Backends are pluggable: Vercel Sandbox, Docker,
  microsandbox (a local VM; macOS on Apple Silicon or Linux with KVM),
  just-bash, or a custom `SandboxBackend` ("your own container runner, VM
  pool, internal sandbox service, or another isolation layer") that returns
  the `SandboxSession` operations: run, spawn, read and write files.
- **Where the brain's state is.** The Workflow "world": `.eve/.workflow-data`
  on disk locally and self-hosted, Vercel Workflow on Vercel, or an installed
  world package such as Postgres through `experimental.workflow.world`. The
  world is the boundary a session cannot cross. Locally, `eve dev` quarantines
  active runs whose code generation no longer exists (our dev log showed nine
  such runs), and a thread from the dev server cannot continue under
  `npm start`.

## What EVE BOT does today

Reading the code against the three lines.

**1. Brain outside, hands separate: yes, with more in the hands than Anthropic
would put there.**

- HQ and every Bot run in the app runtime; the team's computer is one
  sandbox shared by every session (`agent/lib/computer.ts` wraps any backend
  so each session opens the same machine under one key). The console reaches
  the same machine outside any session through the provider's SDK
  (`agent/lib/computer/control.ts`).
- Secrets stay on the brain's side: connector OAuth tokens are sealed per
  workspace in the store, the gateway key never reaches the machine, and the
  shell runs as an unprivileged user behind a network fence so it cannot
  reach the browser or the sign-ins.
- But the hands are heavier than "execute(name, input)". The computer
  carries a Linux desktop, Chrome, agent-browser, websockify, a per-machine
  key, browser profiles (the team's sign-ins), the identity jar, and the
  per-Bot tabs and screens table. The runtime script assumes Linux, and the
  network fence picks iptables, nftables or Landlock by what the kernel
  offers. A Mac cannot be the hands today without a second runtime.

**2. Moving between machines without losing state: partly, and only within a
kind.**

State lives in three places, and each moves differently:

| State | Where | Moves? |
| --- | --- | --- |
| Conversations and runs (turns, steps, parked waits) | eve's Workflow world | No. Bound to the world and, on Vercel, to the deployment that started the run |
| Jobs, roster, memory, actions, usage, connectors | the store (`agent/lib/store`: fs or Vercel Blob) | Not by itself. One driver per deployment; no export or import between fs and Blob |
| The computer's files and sign-ins | the sandbox, plus archives in the store (`computer-backup.ts`) | Within a kind. Backups are keyed by computer kind (Vercel vs local) and refuse a different CPU architecture; browser profiles are not archived, the identity jar is |

So a job survives its machine dying (the next run restores the archive), but
nothing today carries a session from a Vercel deployment to a laptop, or
from a laptop to a Mac. The run would have to be re-created, not moved.

**3. Crash, deploy, dead sandbox, rewind: survived by re-running, not by
resuming; no rewind.**

- A run is a durable background workflow (`agent/tools/run_job.ts`): it
  sleeps until the job is due, claims the job with a lease, delegates to the
  teammate subagent, renews the lease every eight minutes while looking at
  the job every minute, and parks up to a day for sign-off. Workflow gives it
  the eve guarantees above.
- The job record is the fence. A run that lost its lease, or whose job was
  cancelled, is refused on every write and every outward action
  (`run-guard.ts`, `patchJobAsRun`, the teammate's `fence` hook). A watchdog
  (`schedules/tick.ts`) finds due jobs with a lapsed lease and dispatches a
  fresh run.
- A fresh run starts a fresh teammate session. Its brief carries the bot's
  playbook, the job, feedback if the job was sent back, and the previous
  result if one was recorded (`agent/lib/brief.ts`). It does not carry the
  progress log the earlier run wrote with `log_progress` (those are activity
  records in the feed), the pages it had open, or what it had decided. The
  model starts over.
- Every outward action goes through the action ledger (`actions.ts`), keyed
  by job, run and payload hash, so a replayed step finds its receipt instead
  of sending twice. That is the idempotency eve asks for.
- "Rewind" exists only at eve's stream level (`startIndex`), and the console
  uses it to redraw a thread. There is no way to take a job back to a point
  and continue from there, and a routine's run is deliberately handed off
  every 24 hours so code changes reach it, because a run finishes on the
  deployment that started it.

## The gaps, in one list

1. The hands are Linux-only and carry the browser, the sign-ins and the
   screens. A second kind of hands (a Mac, a Windows box, a phone) needs the
   computer runtime split into "what the brain needs from any machine" and
   "what this machine provides".
2. A run's state of mind is in the Workflow journal, which is not portable.
   The portable record (the job, the actions ledger, the progress feed) is
   not enough to continue a run; it is enough to start it again.
3. Backups move files within a kind only, skip browser profiles, and are
   taken at most every `BOT_BACKUP_EVERY_MINUTES`.
4. The store has no export or import, so a workspace cannot follow its owner
   from Vercel Blob to disk or back.
5. There is no rewind of a run. The closest primitives are the sent-back
   revise loop and the event stream's positional reads.
6. Locally, a code change strands active runs (quarantined by the dev world),
   and a standalone rebuild has the same effect. On Vercel the old deployment
   keeps the run alive, which is why the 24-hour routine handoff exists.

## Directions worth discussing

Not a plan. Each is a different amount of work, and some of them are
Anthropic's design choices that eve-bot might not want.

- **Make the job record the session log.** Write what a run learns as it
  goes (progress, decisions, open tabs, files touched) into the job, and have
  the brief of a fresh run replay it, so a re-run after a crash continues
  rather than restarts. This is the cheapest move toward line 3 and gets
  "rewind to the last recorded step" almost for free. It also makes line 2
  mostly a store question.
- **Split the computer into a thin hands protocol.** The brain needs five
  things from a machine: run a command, read and write files, show a screen,
  drive a browser, hand a screen to a person. Put that behind one interface
  with a Linux implementation (today's runtime) and leave room for a Mac one.
  eve's custom `SandboxBackend` is the hook. A Mac runtime is a project of
  its own (Chrome on macOS, a VNC screen, a different fence).
- **Store export and import.** A `npm run export` / `import` that moves a
  workspace between drivers, with the backup archives. Small, and needed for
  line 2 whatever else happens.
- **Treat the Workflow world as replaceable.** eve lets self-hosted agents
  pick a world package (Postgres). A shared world between a laptop and a
  server would let an idle session be picked up elsewhere, which is the one
  path to moving a conversation without re-creating it. Experimental in eve,
  and only idle sessions move even on Vercel.
- **Real rewind.** Beyond "continue from the last recorded step": a point in
  the job's log a person can choose, with the computer's files restored to
  the matching backup generation. Needs per-step backups or a snapshot-capable
  backend (Vercel Sandbox snapshots, microsandbox), and a UI.
