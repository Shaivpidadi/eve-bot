# Backlog

A living list. Pick from the top of a track, tick what lands, add what you
learn. Sizes: S under half a day, M a day, L two to three days. Each task
says what "done" looks like so a week can end mid-track without losing the
thread. Background for the D tracks is in
[../research/brain-hands-durable-runs.md](../research/brain-hands-durable-runs.md);
their task-level status lives in [durable-runs.md](durable-runs.md).

## D0. Stranded runs

The dev world quarantines active runs when the code generation changes; a
standalone rebuild does the same. Vercel keeps old deployments alive, so
this is a local and self-hosted problem.

- [x] **D0.1 (S)** On server start, list quarantined or orphaned Workflow runs
      and log one line per job they belonged to. Done: `npm run dev` after a
      code change prints which jobs lost their run.
- [x] **D0.2 (M)** Have the watchdog treat a job whose run is quarantined as
      lease-lapsed at once instead of waiting for the lease to expire. Done: a
      job interrupted by a rebuild is re-dispatched within one tick.

## D1. The job record as the session log

A fresh run today starts from the brief. Make it continue from where the
last run got to. This is most of "a crash doesn't kill the run" and the base
for rewind.

- [x] **D1.1 (M)** A journal on the job: `job.journal[]` of
      `{at, runToken, kind, text, data?}` with kinds `progress`, `decision`,
      `tab`, `file`, `artifact`, `asked`. Written by `log_progress`, the
      `page_*` tools (current URL and tab), `write_file`, `save_artifact`, and
      `request_takeover`. Capped (last 200). Done: a job's record shows the
      path the Bot took.
- [x] **D1.2 (M)** The brief replays the journal on a retry or revise: a
      "Where the last run got to" section with the last entries, the open
      page, files written, what was asked and answered. Done: kill the server
      mid-job, let the watchdog re-run it, and the new run picks up without
      redoing finished steps.
- [x] **D1.3 (M)** A `note_to_self` tool (or a fold into `log_progress` with
      `kind: decision`) the teammate is told to call at plan changes, so the
      journal carries intent, not only actions. Instructions updated.
- [x] **D1.4 (S)** A QA check that interrupts a running job and asserts the
      re-run's brief carries the journal and the job closes once.
- [x] **D1.5 (M)** Console: the job card shows the journal as a timeline, and
      a re-run shows "continued from step N" where it picked up.

## D2. A workspace that follows its owner

- [x] **D2.1 (M)** `npm run export -- <file>` and `npm run import -- <file>`
      that copy every document under the store prefix, the binary objects
      (backup archives, memory vectors), between any two drivers (fs, Blob).
      Done: a workspace exported from Vercel opens on a laptop with its
      roster, jobs, memory and connectors.
- [x] **D2.2 (M)** On import, open jobs are marked "run lost in the move" and
      the watchdog re-dispatches them (runs do not move, D1 makes the re-run
      continue). Sessions start fresh; the console says so once per room.
- [x] **D2.3 (S)** Document it in `docs/updating.md`, including what does not
      move (Workflow state, the computer unless its backup is current).

## D3. Thin hands

The brain needs five things from a machine: run a command, read and write
files, show a screen, drive a browser, hand a screen to a person. Today they
are tangled with the Linux runtime.

- [x] **D3.1 (L)** Extract a `Hands` interface from `computer/runtime.ts` and
      `computer/control.ts` with the five operations, and make the Linux
      runtime its one implementation. No behaviour change. Done: tests pass,
      a job runs as before on Vercel and Docker.
- [x] **D3.2 (M)** A computer "kind" with capability flags (screen, browser,
      handover, fence) recorded on the backup manifest and shown in the
      console. Done: the Team computer card names its kind.
- [ ] ~~**D3.3 (L)**~~ *parked: no shell on a person's Mac, see durable-runs.md.* Spike: a `mac-ssh` custom `SandboxBackend` that runs
      commands and moves files over SSH to a Mac (cloud or local), shell and
      files only. Done: a job that needs no browser finishes on a Mac.
- [ ] ~~**D3.4 (later)**~~ *parked with D3.3.* Browser and screen on a Mac: Chrome over DevTools,
      screen over VNC, a macOS fence. Its own project.

## D4. One Workflow world for several brains

- [x] **D4.1 (M)** Spike `experimental.workflow.world` with
      `@workflow/world-postgres` against a local Postgres, with `npm run dev`
      and a built `npm start` pointed at the same world. Record whether an
      idle session started by one is picked up by the other, and what the
      sandbox reconnect record does across the two.
- [x] **D4.2 (S)** Write the decision down in `docs/decisions/0002-*.md`.

## D5. Rewind

- [x] **D5.1 (L)** Backup generations tied to journal entries: a backup is
      taken (or a Vercel Sandbox snapshot requested) at each `decision` and
      before each outward action, named by the journal index.
- [x] **D5.2 (L)** "Rewind to here" on a journal entry: cancel the run,
      restore the matching generation onto the computer, start a new run
      whose brief carries the journal up to that index.
- [x] **D5.3 (M)** Rewind a conversation: fork a room at a transcript index
      into a fresh session seeded with the transcript up to that point.

## A. Bots that feel alive

0.3.0 replaced the SVG avatar with a WebGL mascot (`src/console/mascot.tsx`): a
mood per presence including asleep, blinking, eyes and body that follow the
pointer, a spin, and faces that wake on hover. The tab title already counts
who needs you. Re-scope A1 to A9 against it before picking one up; the notes
below are from before it.

Re-scoped and done (15 Oct 2026), on the mascot rather than the SVG:
expressions (A2) — a mouth and brows per mood (a small smile at rest, "hmm"
thinking, a set mouth working, worried brows and an "o" when it needs you, a
frown blocked, a grin done, a line asleep), eased so moods blend (A3);
speaking (A5) — the mouth moves while a reply streams in (`voice.ts`); and
needs-you (A7) — the sidebar face comes alive with an amber ring that pulses.
`/bot/mascots?mood=…&speaking=1` shows them all. The rest (A1, A4, A6, A8,
A9) is already covered by the mascot or no longer needed.

Research (13 Oct 2026): "Muse" is Meta's assistant, relaunched with a plush
mascot, Jolly, designed by Alex Cornell: cream fur, beady eyes, pink cheeks,
customizable, with a keychain device (Muse Charm) that shows the character
on a small screen and a real-time video avatar. The craft worth taking from
it is a character with a stable identity and a small vocabulary of moods
that react to what is happening, not the toy look.

What the console has: an SVG avatar per member (`src/console/avatar.tsx`)
with a shape and colour seeded from the Bot's id, two eyes, a "happy" state,
and CSS motion per presence (idle blink and glance, thinking ponder, working
hop, waiting sway, blocked shiver, done settle), all behind
`prefers-reduced-motion`. That is already the right architecture: zero
dependencies, themeable, tiny, identity never changes.

Options considered:

| Option | Fit | Cost |
| --- | --- | --- |
| Extend the SVG + CSS system | keeps identity and theme, no deps, works at 10px and 96px | design time only |
| Rive characters (state machine in the file) | richest motion, designer-editable | proprietary editor, a WASM runtime, one file per character shape, harder to theme |
| Lottie | playback only, no state logic | wrong tool for reactive presence |
| WebGL orb (OGL, Three) | good for one "thinking" orb, not for a team of distinct characters | shader work, not characters |

Recommendation: extend the SVG system first (A1 to A8), keep a Rive spike
(A9) as an option for a "big" hero avatar later.

- [ ] **A1 (S)** Presence vocabulary audit: list every runtime signal the
      console has (presence, action, streaming deltas, pending input, paused,
      stuck) and map each to a mood: asleep, idle, listening, thinking,
      working, speaking, needs-you, blocked, done. Fill the gaps in
      `room-store.ts` (speaking while deltas arrive; needs-you when an input
      request is pending; asleep after N minutes idle).
- [ ] **A2 (M)** Expression layer in the SVG: a mouth and brows, body squash
      and stretch, per mood. Eight expressions drawn once, applied through
      `data-presence`. Works at every size the console uses (10 to 52px).
- [ ] **A3 (S)** Transitions between moods with the Web Animations API or CSS
      transitions on the eye and mouth paths, so a Bot never snaps from one
      face to another.
- [ ] **A4 (M)** Liveness: blink timing from JS with jitter, eyes glance at
      the composer when it has focus and at the pointer when it is near,
      a "boop" on click. Only for the avatars on screen (IntersectionObserver),
      paused when the tab is hidden.
- [ ] **A5 (S)** Speaking: eyes and mouth pulse with the cadence of
      `message.appended` deltas while a reply streams.
- [ ] **A6 (M)** A hero avatar in the panel (96px) with more room: looks
      around when idle, yawns when asleep, shows a tiny glyph of the tool in
      use (browser, terminal, mail) when working, waves when it needs you.
- [ ] **A7 (S)** Needs-you everywhere: the sidebar row gets a wave and an
      attention ring, the browser tab title gets a marker, and the panel's
      hero avatar waves until the card is answered.
- [ ] **A8 (S)** Budget: at most N animated avatars at once in the roster
      (the rest static), all motion under `prefers-reduced-motion`, no layout
      work from animations (transforms and opacity only). Measured with the
      Performance panel on a 30-Bot roster.
- [ ] **A9 (M, optional)** Rive spike: one character with idle, thinking,
      working, needs-you states, loaded only for the hero avatar. Measure the
      runtime's size and the file's, and whether its colours can follow the
      theme. Decide whether it earns a place.

## E. eve 0.58.1 to 0.79.1 (done 14 Oct 2026)

Twenty minor versions in six weeks (0.78.0 shipped 13 Oct 2026). Not a
dependency bump: 0.69 replaced the task model `run_job` is built on, and
0.67 and 0.68 changed things the cancel path and the console rely on. Do
this before D1, which edits the same files. Sized at three to five days with
the test and QA suites green at the end.

What changes for us, from the changelog and the 0.78 docs:

| Area | 0.58 | 0.78 | Where it bites |
| --- | --- | --- | --- |
| Background runs | `execution: "background"` | `task(input, ctx)`; receipt at once, result as a `task.result` message; the turn stays open (`turn.waiting`, `on: "tasks"`) while tasks work, and steering messages still get replies | `agent/tools/run_job.ts`, the room store and watchdog that read `turn.completed` and `session.waiting` |
| Delegation | `ctx.agent("teammate", { message })` returns the output | `ctx.agent("teammate").send(brief, { signal })` then `result()` gives `{ data, message, status }` | `run_job.ts` (`working`, `salvageResult`) |
| Reserved names | our `agent/tools/task_cancel.ts` disables eve's | `task_cancel` and `task_wait` are reserved (`eve__task_cancel`); a tool by that name fails the build; the `eve` namespace is reserved | delete the override, re-check the "deaf HQ" it worked around |
| Stopping a Bot | the `fence` hook throws in `step.started` | a throwing hook no longer fails the turn; hooks call `ctx.cancel()` instead | `teammate/hooks/fence.ts`, `lib/stops.ts`, `tests/turn-stop.test.ts` |
| Subagent events | `subagent.called/started/completed/event` | `task.started`, `task.settled`, `agent.started`; `session.agent(started).stream()` | usage hooks, ops routes, console projections |
| Stranded sessions | silently stuck after an upgrade | `409 session_stranded`; `reset()` ends it; `ctx.session.predecessor` names the old session and `transcriptReducer()` folds its transcript | the watchdog's recover path can now carry the conversation over |
| Memory capture | provider `capture` never ran (no history on `turn.completed`) | restored (0afae69): providers get the settled history | decide whether hooks stay or capture moves back to the provider |
| Jev | `experimental_evaluate` from `ai` | `decide` and `decisionModel` (ai 7.0.128+); eve needs ai 7.0.137+ | `agent/lib/jev.ts` |
| Sandbox provider handles | `delete()`, `stop()`, `shutdown()`, `captureState`, `useSessionFn` | `onSandboxStop()`, `onRuntimeShutdown()`, `onSandboxDelete()`, `onSessionEnd()` | `agent/lib/computer.ts` (`sharedComputer`) |
| `bash` output | `{ exitCode, stdout, stderr }` | `status: "running" \| "completed"`, `exitCode` only when completed; long commands return early with a pid | our bash wrappers and the shell fence |
| Connection tools | `connection_search`, `connection_execute` | `eve__search`, `eve__tool`; calls named `<connection>__<tool>` | `instructions/connectors.ts`, teammate instructions, `catalog.ts`, the reviewed-reads logic |
| Run modes | child sessions in conversation mode | modes removed; every session parks after a turn; `outputSchema` per turn only | `run_job.ts`, fence comments |
| Local dev | quarantined runs | `eve dev` cancels runs whose snapshots are gone and says why | D0 gets easier |
| Compaction | event log grows for ever | an idle session moves to a fresh run after compaction | long HQ threads |
| Web search | | `webSearch({ provider: "native" })` uses the vendor's search on Gateway | optional |

- [x] **E1 (S)** Branch, bump `eve` to 0.78.0, `ai` to 7.0.139, `@agent-browser/eve`
      to 0.39.0, run `npm run typecheck`, list every error by file. Done: the
      list is in the PR description.
- [x] **E2 (M)** `run_job` on the task model: `task()`, `ctx.agent().send()`,
      result reading, the sign-off `ctx.ask` from a task (stays open across
      messages), the heartbeat loop against `turn.waiting`. Done: a job runs,
      parks for sign-off, is approved, closes once.
- [x] **E3 (M)** Cancel and fence: `ctx.cancel()` in the fence hook, delete the
      `task_cancel` override, re-test the cancel paths (`tests/turn-stop`,
      `cancel.test`), re-check the "HQ goes deaf after task cancel" note.
- [x] **E4 (M)** Console and watchdog on stream version 26: `turn.waiting`,
      `task.*`, `agent.started`, `409 session_stranded`; recover carries the
      old transcript via `predecessor`. Done: a held turn shows as "working on
      N jobs", not as wedged; a stranded room recovers with its history.
- [x] **E5 (S)** Jev on `decide`; sandbox handle hooks in `sharedComputer`;
      bash output `status`; connection tool names in instructions and catalog.
Landed on 0.79.1 instead of 0.78.0, with these departures from the plan:
a team-computer sandbox provider (lib/team-computer.ts) replaces
`sharedComputer`; `run_job` is a resumable task (`serve`) that runs due work
inside the call and waits idle for later work, waking its room through a
durable outbox the server flushes by calling itself (lib/outbox.ts,
lib/self.ts); the fence hook is gone and the model resolver plus `run_job`'s
abort signal stop a cancelled or halted Bot. Verified live on eve dev and on
a Vercel preview: a due job, a job scheduled two minutes out (woken on time
with no console open), a cancel mid-job, a Bot-to-Bot message, and a code
change with a thread open (no stuck thread).

- [x] **E6 (S)** Memory: try provider capture again now that history arrives;
      keep the hooks if the provider still misses job turns. Kept the hooks:
      the provider's history is bare model messages, with no way to tell the
      person from a teammate's note or a task result, and no declined
      approvals. Checked live on 0.79.1: a turn saved "three bullets at most"
      and "small design studio". The memory model must return structured
      output; the free Nemotron model fails its schema.
- [x] **E7 (M)** Full pass: `npm test`, `npm run qa` with `QA_JOBS=1` against a
      scratch deployment, a manual job on Vercel Sandbox and on Docker, a
      sign-in takeover, a connector call with approval. Update the safety doc
      where behaviour moved.
      Done on Vercel (15 Oct 2026): `QA_JOBS=1` against a protected preview
      (`QA_BYPASS`): 11 pass and 4 skip by design (the two "stranger is
      refused" checks behind Vercel's protection, no key-based connector, the
      stranded check on a shared world), none failing. The two that failed
      first were rerun on their own after three fixes the run found (a Bot locked out of its own folder, a
      rewind point racing a write in the same step, the stranded check on a
      shared world). Then by hand on Docker: a browser and shell job, a
      takeover handed back with a note, and a connector call held for
      approval and run once approved. Docker found two more: a template saved
      mid-install, and the console unable to find a Docker computer eve made.

## S. Each Bot on its own screen

Today a workspace has one screen and one browser (`lib/computer/screens.ts`:
"A workspace has one screen"), chosen so sign-ins carry across Bots. Each
Bot has its own tab, tracked in `BotTab`, and `activate` brings a Bot's tab
to the front for takeover. Every thread shows that one screen, so two Bots
at work look like one browser flipping between tabs, and switching threads
reconnects the live view each time. The pool already supports several
screens per machine (`MAX_SCREENS`, default 4, up to 9), and the table once
held one screen per Bot, so the machinery for the other design is there.

- [x] **S1 (M)** A Bot's thread shows its own tab. Posters are captured per
      target (the script already supports it), so each thread's thumbnail is
      that Bot's page, not whoever is in front; HQ's desk shows the front tab.
      Done: two Bots working show two different thumbnails.
      Built with per-job tabs (32fbced): `refreshScreen` captures the run's
      own tab into that Bot's poster, and the poster route falls back to the
      latest frame for HQ. Left: members share the screen's `posterAt`, so a
      new frame from one Bot refetches every thumbnail (correct, just wasteful).
- [x] **S2 (M)** Smooth switching: one live connection per screen kept while
      the console is open, poster crossfades to live instead of
      "Connecting…", posters prefetched for every working Bot, and opening a
      thread brings that Bot's tab to the front only when a person takes over.
      As built (`computer/parked.ts`): closing the computer parks its live
      connection for a minute and the next open adopts it; the still frame
      stays under the picture while it fades in. Opening still brings that
      Bot's tab to the front, so the picture is its work. Measured on a
      Vercel preview: first open live in 2.7 s, reopen in 7 ms. No poster
      prefetch: the board already carries each frame's time.
- [ ] ~~**S3 (L)**~~ *parked: one browser profile per workspace is deliberate, so sign-ins carry across Bots.* A screen per working Bot: its own display and Chrome, the
      profile seeded from the identity jar at start and exported back at the
      end so sign-ins still carry across. The pool caps concurrency (a fifth
      Bot waits or shares). Done: the Team computer card shows one mini screen
      per working Bot, and takeover opens the right one.
- [ ] ~~**S4 (S)**~~ *parked with S3.* Resource check for S3 on Vercel Sandbox and Docker: memory
      per Chrome, `BOT_SANDBOX_VCPUS`, what happens at the cap. Written down
      before S3 starts.

## H. Hiring without the mess

Today "New Bot" is a three-field form (name, job, a 20-character minimum
persona) and HQ hires only when asked. Hiring several Bots means filling it
several times, each lands in an empty thread, and there is no guidance on
what a good persona is.

- [x] **H1 (M)** Templates: Researcher, Inbox triage, Sales follow-up, QA,
      Ops monitor, Custom, each with role, persona, emoji and skills filled
      in and editable, plus a live avatar preview and name suggestions. The
      form becomes two steps: pick, then adjust.
      As built (`lib/templates.ts`, `hire-dialog.tsx`): no avatar preview,
      because a Bot's face is seeded from its id, which exists only once it is
      hired; a preview would show a different face. The server takes skills,
      emoji and the introduction from its own copy of the template.
- [x] **H2 (M)** "Describe your team": one text box, HQ proposes a roster on
      a card (name, role, one-line persona each), approve all or some, and
      `POST /bot/v1/bots/batch` creates them in one go.
      As built: in the New Bot dialog rather than HQ's thread. The quick model
      proposes up to five (`lib/roster.ts`, `POST /bot/v1/bots/propose`), each
      matched to a template when one fits, never one the team already has;
      the person ticks which to hire.
- [x] **H3 (S)** A new Bot introduces itself: its thread opens with a short
      hello in its own voice and one suggested first job, so no thread starts
      empty.
      As built: three first jobs, not one. A template brings its own; any
      other Bot gets one quick-model call when it is hired (in the background
      from the console, awaited with a 15 s cap from `hire_bot` and
      `create_bot`), charged to the new Bot.
- [x] **H4 (S)** Clone and edit from any Bot's menu (today's duplicate, with
      the form open on the copy).
- [x] **H5 (S)** Form polish: inline validation, duplicate-name check before
      submit, keyboard flow, the dialog on a sheet like Memory and Connectors.
      As built: the name is checked against the team as you type, a short
      "how it should work" says how many characters it still needs, the
      name field takes focus, and ⌘/Ctrl+Enter hires. It stays a dialog: a
      sheet suits the long Memory and Connectors pages, not a short form.

## What's next

Every track above is done or parked. New work goes here.
