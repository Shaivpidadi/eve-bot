# Backlog

A living list. Pick from the top of a track, tick what lands, add what you
learn. Sizes: S under half a day, M a day, L two to three days. Each task
says what "done" looks like so a week can end mid-track without losing the
thread. Background for the D tracks is in
[../research/brain-hands-durable-runs.md](../research/brain-hands-durable-runs.md).

## D0. Stranded runs

The dev world quarantines active runs when the code generation changes; a
standalone rebuild does the same. Vercel keeps old deployments alive, so
this is a local and self-hosted problem.

- [ ] **D0.1 (S)** On server start, list quarantined or orphaned Workflow runs
      and log one line per job they belonged to. Done: `npm run dev` after a
      code change prints which jobs lost their run.
- [ ] **D0.2 (M)** Have the watchdog treat a job whose run is quarantined as
      lease-lapsed at once instead of waiting for the lease to expire. Done: a
      job interrupted by a rebuild is re-dispatched within one tick.

## D1. The job record as the session log

A fresh run today starts from the brief. Make it continue from where the
last run got to. This is most of "a crash doesn't kill the run" and the base
for rewind.

- [ ] **D1.1 (M)** A journal on the job: `job.journal[]` of
      `{at, runToken, kind, text, data?}` with kinds `progress`, `decision`,
      `tab`, `file`, `artifact`, `asked`. Written by `log_progress`, the
      `page_*` tools (current URL and tab), `write_file`, `save_artifact`, and
      `request_takeover`. Capped (last 200). Done: a job's record shows the
      path the Bot took.
- [ ] **D1.2 (M)** The brief replays the journal on a retry or revise: a
      "Where the last run got to" section with the last entries, the open
      page, files written, what was asked and answered. Done: kill the server
      mid-job, let the watchdog re-run it, and the new run picks up without
      redoing finished steps.
- [ ] **D1.3 (M)** A `note_to_self` tool (or a fold into `log_progress` with
      `kind: decision`) the teammate is told to call at plan changes, so the
      journal carries intent, not only actions. Instructions updated.
- [ ] **D1.4 (S)** A QA check that interrupts a running job and asserts the
      re-run's brief carries the journal and the job closes once.
- [ ] **D1.5 (M)** Console: the job card shows the journal as a timeline, and
      a re-run shows "continued from step N" where it picked up.

## D2. A workspace that follows its owner

- [ ] **D2.1 (M)** `npm run export -- <file>` and `npm run import -- <file>`
      that copy every document under the store prefix, the binary objects
      (backup archives, memory vectors), between any two drivers (fs, Blob).
      Done: a workspace exported from Vercel opens on a laptop with its
      roster, jobs, memory and connectors.
- [ ] **D2.2 (M)** On import, open jobs are marked "run lost in the move" and
      the watchdog re-dispatches them (runs do not move, D1 makes the re-run
      continue). Sessions start fresh; the console says so once per room.
- [ ] **D2.3 (S)** Document it in `docs/updating.md`, including what does not
      move (Workflow state, the computer unless its backup is current).

## D3. Thin hands

The brain needs five things from a machine: run a command, read and write
files, show a screen, drive a browser, hand a screen to a person. Today they
are tangled with the Linux runtime.

- [ ] **D3.1 (L)** Extract a `Hands` interface from `computer/runtime.ts` and
      `computer/control.ts` with the five operations, and make the Linux
      runtime its one implementation. No behaviour change. Done: tests pass,
      a job runs as before on Vercel and Docker.
- [ ] **D3.2 (M)** A computer "kind" with capability flags (screen, browser,
      handover, fence) recorded on the backup manifest and shown in the
      console. Done: the Team computer card names its kind.
- [ ] **D3.3 (L)** Spike: a `mac-ssh` custom `SandboxBackend` that runs
      commands and moves files over SSH to a Mac (cloud or local), shell and
      files only. Done: a job that needs no browser finishes on a Mac.
- [ ] **D3.4 (later)** Browser and screen on a Mac: Chrome over DevTools,
      screen over VNC, a macOS fence. Its own project.

## D4. One Workflow world for several brains

- [ ] **D4.1 (M)** Spike `experimental.workflow.world` with
      `@workflow/world-postgres` against a local Postgres, with `npm run dev`
      and a built `npm start` pointed at the same world. Record whether an
      idle session started by one is picked up by the other, and what the
      sandbox reconnect record does across the two.
- [ ] **D4.2 (S)** Write the decision down in `docs/decisions/0002-*.md`.

## D5. Rewind

- [ ] **D5.1 (L)** Backup generations tied to journal entries: a backup is
      taken (or a Vercel Sandbox snapshot requested) at each `decision` and
      before each outward action, named by the journal index.
- [ ] **D5.2 (L)** "Rewind to here" on a journal entry: cancel the run,
      restore the matching generation onto the computer, start a new run
      whose brief carries the journal up to that index.
- [ ] **D5.3 (M)** Rewind a conversation: fork a room at a transcript index
      into a fresh session seeded with the transcript up to that point.

## A. Bots that feel alive

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

## Suggested first week

In order, with what each day leaves behind if the week ends there:

1. D1.1, D1.2 (the journal and the brief that replays it)
2. D1.4, D0.2 (prove a kill mid-job continues; local rebuilds re-dispatch)
3. A1, A2 (mood vocabulary and the expression layer)
4. A3, A4, A5 (transitions, liveness, speaking)
5. D2.1 (export and import), A7 (needs-you)

Left for later: D1.3, D1.5, D2.2, D2.3, D3, D4, D5, A6, A8, A9.
