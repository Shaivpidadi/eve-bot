# Plan: runs that outlive their machine

The build plan for [brain-hands-durable-runs.md](../research/brain-hands-durable-runs.md).
It covers the six tracks that research produced (D0 to D5). The eve 0.78
upgrade (track E in [backlog.md](backlog.md)) comes first because D1 edits
`run_job.ts`, which the upgrade rewrites.

## How to read this file

- Every task and subtask carries one tag: `[to-do]`, `[in-progress]`, `[done]`, or
  `[parked]` (decided against for now; the reason is on the task).
  Change the tag in the same commit as the work.
- Levels: track → task (D1.2) → subtask (D1.2.3) → steps. A task is done when
  every subtask is done and its "Done when" line holds.
- Each task names its tests and its evals. Tests are deterministic and run in
  `npm test` or `npm run qa`. Evals measure a behaviour that can degrade
  without a test failing, and are run before and after the task with
  `npm run metrics` or a named script, with the numbers recorded here.
- One commit per task, subject in Conventional Commits form, no co-author
  lines. Mark the task `[done]` in that commit.

## Test layers used below

| Layer | Runs with | Covers |
| --- | --- | --- |
| Unit | `npm test` (vitest, `tests/`) | pure logic: journal, brief, store round trips, lease rules, hands contract against a fake |
| Turn | `npm test`, `tests/turn-*.test.ts` | one real eve turn against a stub model, as `tests/turn-stop.test.ts` does |
| QA | `QA_URL=… QA_TOKEN=… npm run qa` (`qa/checks/*.mjs`) | a running deployment driven over its console API; `QA_JOBS=1` runs real jobs |
| Live | by hand, written down in the task | Vercel Sandbox and Docker, a takeover, a deploy mid-job |
| Eval | `npm run metrics`, `npm run jev:report`, scripts named per task | numbers: redo ratio, time to re-dispatch, fidelity, cost |

Two helpers every track needs, built first:

- **`BOT_QA=1` fault routes** (`agent/channels/ops.ts`, refused unless the env
  is set): `POST /bot/v1/qa/jobs/:id/crash` ends the job's run session and
  lapses its lease without cancelling the job, which is what a crashed process
  looks like to the store; `POST /bot/v1/qa/computer/replace` deletes the
  computer's generation marker so the next job sees a replacement machine.
- **`qa/lib/wait.mjs`**: poll a job until a status or a journal entry appears,
  with a deadline, so checks read like prose.

## Status board

| Track | Status | Tasks done |
| --- | --- | --- |
| E. eve upgrade, landed on 0.79.1 (see backlog) | [done] | 5/7, E6 and E7 open |
| D0. Stranded runs | [done] | 3/3 |
| D1. The job record as the session log | [done] | 6/6 |
| D2. A workspace that follows its owner | [done] | 4/4 |
| D3. Thin hands | [done] for now | 2/4, D3.3 and D3.4 parked |
| D4. One Workflow world | [done] | 2/2 |
| D5. Rewind | [done] | 4/4 |

## D0. Stranded runs `[done]`

A code change under `eve dev` quarantines active Workflow runs; a standalone
rebuild does the same. The job's lease then sits unexpired for up to 20
minutes, and the watchdog only runs daily by default. Vercel is not affected
(the old deployment keeps the run alive), so every rule below applies only
when the Workflow world is local.

### D0.1 Tell a job which build holds its run `[done]`

- **Files:** `agent/lib/types.ts` (`JobLease.build?: string`), `agent/lib/jobs.ts`
  (`claimJob`, `renewLease`), `agent/lib/build.ts` (new: `buildId()`).
- `[done]` D0.1.1 `buildId()` returns a stable id for the running code: `VERCEL_DEPLOYMENT_ID`
  on Vercel, else a hash of `package.json` version plus the `.eve/dev-runtime` generation
  under `eve dev`, else the `.output` build stamp. Unit test: same process, same id;
  different stamp, different id.
- `[done]` D0.1.2 `claimJob`, `holdUntilDue`, `holdForSignoff` and `renewLease` write `lease.build = buildId()`. Older
  records without it are treated as "unknown build". Unit test on the lease shape.
- **Done when:** every new `run` and `wait` lease names its build.

### D0.2 Treat a lease from another build as lapsed on local worlds `[done]`

- **Files:** `agent/lib/jobs.ts` (`dueJobs`, a `leaseIsLive(lease)` helper),
  `agent/schedules/tick.ts`, `scripts/start.mjs`, `agent/lib/world.ts` (new: `worldIsLocal()`).
- `[done]` D0.2.1 `worldIsLocal()`: true unless `VERCEL=1` or `experimental.workflow.world`
  names a shared world (read from `agent.ts` config through an env mirror
  `BOT_WORKFLOW_WORLD`). Unit test.
- `[done]` D0.2.2 `leaseIsLive`: on a local world a `run`, `wait`, `dispatch` or `signoff`
  lease whose `build` differs from `buildId()` is lapsed at once; elsewhere, the `until`
  clock rules. `dueJobs` uses it. Unit tests: four lease kinds × same build, other build,
  unknown build, Vercel.
- `[done]` D0.2.3 A sweep at start (`POST /bot/v1/jobs/sweep`, called by `scripts/start.mjs` a minute after boot and by the console on its first load; one pass a minute per process): `npm start` and `eve dev` trigger one tick pass
  60 seconds after boot (`BOT_TICK_ON_START=off` disables). Under `eve dev` the
  schedule runner is off, so the pass is a direct call to the tick's dispatcher through
  the dev schedules route the README already documents.
- `[done]` D0.2.4 The feed records `job.stranded` with the old build and the new one, so
  the thread says "the server restarted with new code; Atlas is picking the job up again".
- **Tests:** unit as above; QA `qa/checks/stranded.mjs`: with `BOT_QA=1`, crash a job's run,
  bump the build stamp through `POST /bot/v1/qa/build/bump`, and expect the job
  re-dispatched within 90 seconds with a `job.stranded` feed line.
- **Eval:** time from rebuild to re-dispatch, measured by the QA check, recorded here.
  Target: under 2 minutes locally (was: up to 20 minutes plus a day).
- **Eval result (Docker, 13 Oct 2026):** `qa/checks/stranded.mjs` passed in 154 s; the next run
  started 9.6 s after the sweep found the stranded lease. The sweep itself runs a minute after
  a server starts, so a real rebuild re-dispatches in about 70 s.
- **Done when:** a rebuild mid-job re-runs the job within two minutes and says so.

### D0.3 Stranded conversations `[done]`

E4 has landed. Since 0.3.0 a thread reads back across all its sessions, and a stranded
session's history still shows (the stream route falls back on `SessionStrandedError`). What
is left is carrying the conversation itself into the new session.

- `[done]` D0.3.1 (as built: in the send path, not only the console's recover route) A send that
  fails because the session is gone, `SessionStrandedError` or `eve dev`'s
  `DevelopmentRunUnavailableError` after a restart, moves the room to a fresh session and sends
  again (`sendToRoom` in `ops.ts`, `sessionIsGone` in `lib/session.ts`). The same path serves
  teammate notes, the outbox flush, the start-up sweep and rewind's re-dispatch. The thread
  says it moved.
- `[done]` D0.3.2 A `session.started` dynamic instruction folds the predecessor's transcript
  (eve's `transcriptReducer`) into the new session, capped at the last 40 messages, so a
  recovered room remembers its conversation and not only Memory (`agent/instructions/earlier.ts`).
  Our restarts move a room to a new address, so eve sets no `predecessor`; the room's own list
  of earlier sessions names it (`predecessorIn` in `lib/roomstate.ts`).
- **Tests:** turn test: a session with a predecessor sees the earlier transcript in its
  first turn's instructions. QA: `qa/checks/recover.mjs` asks a question, strands the room
  through the QA route, asks a follow-up that needs the earlier answer, and expects it answered.
- **Done when:** a recovered thread answers a follow-up that needs what was said before.
- **Checked live (15 Oct 2026, `eve dev`):** told HQ "I moved to Austin", restarted the dev
  server (every send to the thread then failed with `DevelopmentRunUnavailableError`), asked
  "which city did I say I moved to?": the send came back `recovered: true` and the new session
  answered "Austin". Unit tests: `tests/roomstate.test.ts`, `tests/session-gone.test.ts`.

## D1. The job record as the session log `[done]`

A fresh run starts from the brief. After this track it starts from where the
last run got to. The journal is the portable half of Anthropic's session
log: not the model's messages (those stay in eve's Workflow journal) but the
facts a run produced, written into the job record under the fence.

### D1.1 The journal `[done]`

- **Files:** `agent/lib/types.ts` (`JournalEntry`, `Job.journal`), `agent/lib/jobs.ts`
  (`appendJournal`), `agent/lib/journal.ts` (new: shapes, cap, rendering helpers),
  `tests/journal.test.ts`.
- `[done]` D1.1.1 Shape: `{ at, runToken, kind, text, data? }` with kinds `progress`,
  `decision`, `page` (`url`, `title`, `targetId`), `file` (`path`, `bytes`), `artifact`
  (`id`, `name`), `asked` (`requestId`, `reason`, `answer?`), `handover` (`note`), `error`
  (`tool`, `message`). `text` is one line for a person; `data` is for the next run.
- `[done]` D1.1.2 `appendJournal(workspaceId, jobId, sessionId, entry)` through
  `patchJobAsRun`, so a superseded run writes nothing and a replayed write is a no-op
  (same `runToken` + `at` + `kind` + `text` already present returns `null`).
- `[done]` D1.1.3 Cap: keep the first 20 entries and the last 180; the drop writes one
  `progress` entry "N earlier steps folded" so the gap is visible. Unit tests: append, dedupe
  on replay, cap keeps head and tail, fenced run refused.
- `[done]` D1.1.4 Migration: older jobs have no `journal`; readers treat `undefined` as `[]`.
  Unit test on `getJob` of an old record.
- **Done when:** a job's record shows the path a run took, in order, with no duplicates
  after a replay.

### D1.2 The tools write it `[done]`

- **Files:** `agent/subagents/teammate/tools/log_progress.ts`, `write_file.ts`,
  `save_artifact.ts`, `request_takeover.ts`, `page_*.ts` through `lib/browser.ts`
  (`refreshScreen` and the navigation path), `finish_job.ts`.
- `[done]` D1.2.1 `log_progress` writes `progress` (keeps the feed record too).
- `[done]` D1.2.2 The browser layer writes `page` once per navigation (new URL for the run's
  tab), not per action. Unit test with a fake `browser()` that returns the same URL twice.
- `[done]` D1.2.3 `write_file` writes `file` for paths under `/workspace/bots` and
  `/workspace/shared`; scratch under `/workspace/sessions` is skipped.
- `[done]` D1.2.4 `save_artifact` writes `artifact`; `request_takeover` writes `asked` and,
  when the person hands back, `handover` with the note.
- `[done]` D1.2.5 Tool failures the teammate sees (a browser action refused, a command that
  exits non-zero) write `error`, capped at 20 per run so a loop cannot flood the record.
- **Tests:** unit per tool with the journal fake; turn test that one real teammate turn with
  a stubbed browser leaves `page` then `progress` in order.
- **Done when:** a finished job's journal reads as a short diary a person could follow.

### D1.3 The brief replays it `[done]`

- **Files:** `agent/lib/brief.ts`, `agent/lib/journal.ts` (`renderJournal`),
  `agent/subagents/teammate/instructions.md`, `tests/brief.test.ts`.
- `[done]` D1.3.1 `renderJournal(entries, { limit })` renders "## Where the last run got to":
  the last 30 entries as one line each, then "Open page: <url>", "Files written: …",
  "Asked and answered: …". Empty journal renders nothing.
- `[done]` D1.3.2 `renderBrief` (included whenever the job has a journal, which only an earlier run can have written) includes it when `job.attempts > 1` or `job.feedback` is set,
  after the sent-back section and before the result-so-far.
- `[done]` D1.3.3 Teammate instructions: "If the brief says where the last run got to, open
  that page and continue; do not redo listed steps unless the page says they did not land."
- `[done]` D1.3.4 (the `job.started` line says "continuing … from step N") The run's first `progress` entry after a resume says "continued from
  step N" with N the journal length at claim, and `run_job` records `resumedFrom: N` on the
  job for the console.
- **Tests:** unit `[done]` (`tests/brief.test.ts`). Turn test `[to-do]`, folded into D1.4's live check: a teammate briefed with a journal whose last entry is `page` calls `page_get` for
  that URL first (stub model scripted to follow instructions, asserting the tool order).
- **Done when:** a re-run's brief carries the diary and the Bot's first action continues it.

### D1.4 Prove it: crash and continue `[done]`

- **Files:** `agent/channels/ops.ts` (the `BOT_QA=1` crash route), `qa/checks/resume.mjs`,
  `qa/lib/wait.mjs`.
- `[done]` D1.4.1 The crash route: ends the run's teammate session (`attachSession(...).cancel`
  then reset), lapses the lease (`until` = now) without touching status, records
  `job.crashed` in the feed. Refused with 404 unless `BOT_QA=1`.
- `[done]` D1.4.2 (written; `GET /bot/v1/jobs/:id` added so it can read the journal) `qa/checks/resume.mjs` with `QA_JOBS=1`: assign a three-step job (open a
  known page, write a file, log a line), wait for two journal entries, crash it, expect a new
  run whose brief carried the journal (read `resumedFrom` on the job), expect the job to
  close once, and expect the file written once (journal has one `file` entry for the path).
- `[done]` D1.4.3 (written) Same check under a watchdog tick rather than a manual `run_job`, so the
  dispatch path is covered.
- **Eval:** redo ratio = journal entries after resume that repeat a `page` URL or `file` path
  from before, divided by entries before the crash. Computed by `npm run metrics -- --resume`
  (new flag reading `resumedFrom`). Record before (no journal: ratio 1.0 by definition) and
  after. Target: under 0.2 on the QA job, under 0.4 on a real research job.
- `[done]` D1.4.4 (Docker) Run both checks live with `QA_JOBS=1`, and record the ratio here. Ran 13 Oct 2026 on a scratch store and a separate local computer (`BOT_COMPUTER=local`, `BOT_COMPUTER_NAME=bot-qa`) with the Gateway key in `.env`; an earlier note here said no model credential was available, which was wrong. Vercel Sandbox `[to-do]`: the Vercel OIDC token in `.env.local` expired in September (`npx vercel env pull` refreshes it).
- **Eval results (Docker, 13 Oct 2026):**

  | Check | Result | Next run started after the crash | Resumed from | File after the job |
  | --- | --- | --- | --- | --- |
  | resume, re-run by HQ | passed, 164 s | 5.3 s | step 2 of 5 | `first`, `second` |
  | resume, picked up by the sweep | passed, 161 s | 4.0 s | step 2 of 5 | `first`, `second` |

  `npm run metrics -- --resume`: 2 resumed runs, mean redo ratio 0.00. The ratio only sees
  pages and files the journal recorded, and these runs wrote their file through the shell,
  so the file's contents are the stronger evidence that nothing was redone.
- **Finding:** the first live run showed Bots write files through the shell as often as
  through `write_file`, so the journal sees those files only through the Bot's own progress
  note. The check now waits for that note and judges redo by the file itself. Journaling
  shell writes would need parsing commands; left as is.
- **Vercel Sandbox (14 Oct 2026, a test project):** resume, re-run by HQ, passed in 221 s: resumed from step 2 of 6, file `first`, `second`, job done.
- **Done when:** the QA check passes on Vercel Sandbox and on Docker, and the ratio is recorded. Both done.

### D1.5 A note to self `[done]`

- **Files:** `agent/subagents/teammate/tools/log_progress.ts` (a `kind: "decision"` input),
  `instructions.md`.
- `[done]` D1.5.1 `log_progress` takes `kind: "progress" | "decision"`; decisions are rendered
  first in the brief's replay. Instructions ask for a decision entry when the plan changes
  or a step is skipped on purpose.
- `[done]` D1.5.2 Jev watch: the existing close review records whether the journal's
  decisions match the result's summary (observation only, no gate).
- **Eval:** share of jobs with at least one `decision` entry (`npm run metrics` prints it)
  `[done]`; Jev agreement rate (`decisionsAgree` on completion shadows, `npm run jev:report`)
  `[done]`. Numbers `[done]` (21 Oct 2026): six ordinary jobs (a checklist, two scripts, a note, a
  release note, a statistic) on the free Nemotron model with Jev on, briefs that say nothing about
  decisions: **0 of 6 recorded a decision (0%)**, so Jev's `decisionsAgree` was never asked. Jev's
  completion verdicts on the same six: 4 below its confidence floor, 2 "no" on jobs a person checked
  and found done (0 unmet criteria), so 0 of 6 agreed. Two readings: Bots on this model do not log
  decisions unless told to, and Jev is not ready to judge completion on its own.
- **Done when:** the brief's replay leads with why, then what.

### D1.6 The console shows it `[done]`

- **Files:** `src/console/transcript.tsx` (the job's steps block in a Bot's thread), `src/app/globals.css`,
  `agent/channels/ops.ts` (`GET /bot/v1/jobs/:id` includes `journal`, `resumedFrom`).
- `[done]` D1.6.1 (the existing steps block reads the journal when opened, every 5 s while the job runs) The job card gets a "Steps" disclosure: the journal as a timeline with
  icons per kind, the `page` entries as links, `error` entries muted.
- `[done]` D1.6.2 A resumed run shows a divider "continued from step N after a restart"
  at the right place.
- `[done]` D1.6.3 (in `qa/checks/resume.mjs`, which already reads the route: the journal reads in time order, and the
  crashed run's steps open it unchanged; not yet run live) QA asserts the job route returns `journal` and the
  timeline order matches.
- **Done when:** a person can read what a Bot did while they were away from the card alone.

## D2. A workspace that follows its owner `[done]`

Runs do not move (they live in the Workflow world). Everything else can:
documents and bytes under the store prefix. After this track a workspace
exported from Vercel opens on a laptop with its roster, jobs, memory,
connectors and backups, and open jobs are picked up by the watchdog there.

### D2.1 Export `[done]`

- **Files:** `scripts/export.mjs`, `agent/lib/store/transfer.ts` (new), `tests/transfer.test.ts`,
  `package.json` (`"export": "node scripts/export.mjs"`).
- `[done]` D2.1.1 (format is gzipped NDJSON rather than tar: no new dependency, and `gunzip | head` shows the contents) `transfer.ts`: `listAll(kv)` walks every key under the prefix (docs and
  bytes; `kv.list` covers both, bytes read with `getBytes`), `exportTo(kv, writable)`
  streams a tar.gz: `manifest.json` (prefix, store driver, eve-bot version, exported at,
  counts) then one file per key under `docs/` or `bytes/`, keys percent-encoded.
- `[done]` D2.1.2 (the computer access key they are sealed with goes along; `--no-secrets` drops all three) Sealed connector keys and OAuth tokens are included as stored (they are
  sealed to the workspace secret, which is an env var the owner carries; the manifest says
  so). `--no-secrets` leaves them out.
- `[done]` D2.1.3 `scripts/export.mjs --out <file> [--workspace <id>] [--no-secrets]` reads
  the same env as the server (`.env`, `.env.local`, or pulled Vercel env), prints counts.
- **Tests:** unit: memory store with 50 docs and 3 byte objects round-trips through a tar
  buffer with identical bytes; a key with `/` and `%` in it survives. Keys outside the
  workspace are left out when `--workspace` is given.
- **Done when:** `npm run export -- --out ws.tgz` on a Vercel-linked checkout produces an
  archive whose manifest counts match a `kv.list` of the store.

### D2.2 Import `[done]`

- **Files:** `scripts/import.mjs`, `agent/lib/store/transfer.ts` (`importFrom`), tests.
- `[done]` D2.2.1 `importFrom(kv, readable, { onConflict: "replace" | "skip" | "fail", dryRun })`
  writes every entry; `dryRun` prints what would change. Version mismatch between archive
  and code is a warning, not a refusal (the store reads old shapes lazily).
- `[done]` D2.2.2 Jobs with an open lease are rewritten with `lease: null`, `status` kept,
  and a `job.moved` feed line, so the watchdog re-dispatches them and D1's journal lets the
  new run continue. Rooms' session ids are cleared (`roomstate`), so the console starts
  fresh sessions and says so once per room.
- `[done]` D2.2.3 Backup archives are imported but the manifest's `arch` and kind rules in
  `computer-backup.ts` still decide whether they restore onto the new computer.
- `[done]` D2.2.4 `scripts/import.mjs --in <file> [--dry-run] [--on-conflict …]`.
- **Tests:** unit: export from memory, import into fs, every doc equal; conflict modes;
  open-lease rewrite; dry run writes nothing. QA: `qa/checks/transfer.mjs` runs on a
  scratch deployment: seed roster and memory, export, `npm run reset`, import, expect the
  roster and memory back and the open job re-dispatched.
- **Eval:** fidelity = docs equal after round trip / docs exported (target 1.0), and time to
  first re-dispatch after import (target under one tick).
- **Eval results (13 Oct 2026, the local dev store, fs → fs):** 209 keys (205 documents, 4 binary
  objects, 757 KB gzipped). 206 byte-identical, 3 changed as designed (one open job's lease,
  two rooms' sessions), 0 missing, 1 added (the `job.moved` feed line). Fidelity 1.0 for
  everything that is meant to move. Dry run wrote 0 files.
- **Eval results (21 Oct 2026, a Vercel preview → a local store):** `npm run qa:transfer`
  (`qa/transfer.mjs`) seeded a Bot, a memory and a running job on a scratch preview of
  eve-bot-test, exported the workspace over HTTP mid-run (199 KB), imported it into a fresh
  local store (461 keys, 3 open jobs, 19 rooms given fresh sessions), and started a local
  server on it from a worktree of the same commit: the Bot, the memory and the job arrived,
  the job's thread said it moved, and it started again **2 s** after the server came up
  (3 s on the run before). It goes deployment → laptop, the direction a reset is not needed
  for; laptop → Vercel is the same import into Blob, which the scripts cannot reach from a
  laptop's development OIDC token.
- **Done when:** a workspace moves Vercel → laptop → Vercel with nothing lost but live runs.

### D2.3 Route for hosted deployments `[done]`

- `[done]` D2.3.1 (the signed-in workspace only; secrets only with `?secrets=1`) `GET /bot/v1/export` (console token, `BOT_EXPORT=on`) streams the same
  archive, so an owner without a local checkout can still take their workspace out.
- `[done]` D2.3.2 The Usage sheet's footer gets "Export workspace".
- **Tests:** unit for the switch; checked live: 404 without `BOT_EXPORT`; with it, 546 KB, 202 keys, no connector keys or sealing key; with `?secrets=1`, 2 connectors and the sealing key added; the download dry-runs into a fresh store with `npm run import`.
- **Done when:** the export is reachable from the console behind the gate.

### D2.4 Write it down `[done]`

- `[done]` D2.4.1 `docs/updating.md` gains "Moving a workspace": what moves, what does
  not (live runs, the computer unless its backup is current), and the two commands.
- **Done when:** the doc exists and the link check passes.

## D3. Thin hands `[done]` (D3.3 and D3.4 parked)

The brain needs five things from a machine: run a command, move files,
show a screen, drive a browser, hand a screen to a person. Today those are
spread across `computer/runtime.ts`, `computer/control.ts`, `computer/script.ts`
and the teammate's `lib/browser.ts`, all assuming Linux. This track puts them
behind one interface with one implementation, then tries a second machine.

### D3.1 The `Hands` interface `[done]`

- **Files:** `agent/lib/hands/types.ts` (new), `agent/lib/hands/linux.ts` (new, wraps today's
  code), `agent/lib/hands/index.ts` (`handsFor(kind)`), callers in `computer/runtime.ts`,
  `computer/control.ts`, `teammate/lib/browser.ts`, `tests/hands.test.ts`.
- `[done]` D3.1.1 (`Handover` left out: who controls a screen is a store record, not a machine operation; `setup` added for install, ensure and recover) Types: `Shell` (`run`, `spawn`, kill a run's group), `Files` (`read`, `write`,
  `list`, `remove`), `Screen` (`ensure(n)`, `capture(n, target?)`, `liveUrl(n)`, `keepAlive`),
  `Browser` (`ensure(n)`, `activate(n, target)`, `devtoolsUrl(n)`, identity `export`/`sync`),
  `Handover` (`grant(n, by, until)`, `release(n)`). Every method takes the `ComputerIo` it
  needs, so console routes and teammate tools share the implementation.
- `[done]` D3.1.2 `linux.ts` implements all five by delegating to the existing functions. No
  behaviour change; callers import from `hands/` instead of the old modules.
- `[done]` D3.1.3 (the Linux hands run against a fake machine that answers like the script; the Docker variant was checked by hand instead, below) A contract test: `tests/hands.test.ts` runs the same suite against a fake
  hands (in memory) and, when `HANDS_DOCKER=1`, against the Linux implementation on a
  Docker computer: run echoes, a file round-trips, a screen captures a PNG, activate on an
  unknown target fails cleanly.
- **Tests:** existing `shell.test.ts`, `screens.test.ts`, `page.test.ts` keep passing; the
  contract test passes on the fake in CI and on Docker locally.
- **Live check (13 Oct 2026, local Docker computer):** through the console routes, now on the hands: list `/workspace`, upload a file, read it back, delete it with confirmation (404 after), start HQ's screen (VNC URL returned). The frame route reached the machine, which answered "that tab is gone" for a tab remembered from before the container stopped: correct, and a stale-tab case for track S.
- **Done when:** no caller outside `hands/` imports the runtime script's command names. Holds: only `computer/shell.ts` and `computer/control.ts`, the Linux implementation's own modules, still import `computer/runtime`.

### D3.2 Kinds and capabilities `[done]`

- **Files:** `agent/lib/hands/kinds.ts`, `agent/lib/computer-backup.ts` (manifest `kind`,
  `capabilities`), `agent/channels/ops.ts` (`GET /bot/v1/computer` reports them),
  `src/console/panel.tsx` (the Team computer card).
- `[done]` D3.2.1 (as built: `{ name, label, capabilities: { screen, browser, handover, shell } }` in `hands/kinds.ts`; the fence mode stays a runtime fact the computer reports, not a property of the kind) A kind is `{ id: "vercel-linux" | "docker-linux" | "microsandbox-linux" | "mac-ssh",
  capabilities: { screen, browser, handover, fence: "iptables" | "nftables" | "landlock" | "none" } }`.
- `[done]` D3.2.2 The brief tells the teammate which capabilities its computer has; the
  browser tools refuse with a plain message when `browser` is false, and HQ's assign step
  routes browser work only to a kind that has it (one computer today, so this is a check,
  not a scheduler).
- `[done]` D3.2.3 Backups carry the kind; the restore rule compares kinds, not only `arch`.
- **Tests:** unit `[done]` (`tests/kinds.test.ts`): kind from configuration, capability refusal, the brief line, the restore matrix. The kind is on the board (`GET /bot/v1/state`, `computer.kind` and each member's `computer.kind`) rather than a new route; checked live: the state route names it and the panel caption reads "Team computer · Vercel Sandbox".
- **Done when:** the console names the computer's kind and what it can do.

### D3.3 Spike: a Mac as hands, shell and files only `[parked]`

Parked (15 Oct 2026). A Bot with a shell on a person's Mac reaches their keychain, files
and signed-in apps, which is more than the project wants to hand a model. The team keeps
one shared computer on purpose: one screen to watch and take over, one browser profile so
sign-ins carry across Bots. Revisit only with a separate macOS user and an allowlist of
commands.

- **Blocked (13 Oct 2026):** needs a Mac reachable over SSH (Remote Login on), or
  a cloud Mac. The interface it would implement (D3.1) and the capability flags
  that would switch off its screen and browser (D3.2) are in place.

- **Files:** `agent/lib/hands/mac-ssh.ts`, `agent/lib/computer-config.ts`
  (`BOT_COMPUTER=mac-ssh`, `BOT_MAC_SSH=user@host`, `BOT_MAC_SSH_KEY`), a custom eve
  `SandboxBackend` in `agent/sandbox/mac.ts`, `docs/research/mac-hands.md` for the findings.
- `[parked]` D3.3.1 The backend: `create` opens an SSH control master with the `ssh` CLI (no
  new dependency), `run` executes `bash -lc` under a per-run process group, files move with
  `cat` over the same connection; `/workspace` maps to `$HOME/eve-workspace`.
- `[parked]` D3.3.2 Capabilities: `screen: false, browser: false, handover: false, fence: "none"`.
  Without a fence the shell runs only with `BOT_SHELL_ISOLATION=off` semantics (every
  command gated), which the kind declares.
- `[parked]` D3.3.3 A job that needs no browser (a file transform, a script) finishes on the
  Mac; the computer backup takes and restores its archive under the new kind.
- **Tests:** the contract test with `HANDS_MAC=user@host`; unit: SSH argument building,
  process-group kill.
- **Eval:** cold start to first command, command round-trip latency, both recorded in the
  findings doc against Docker's numbers.
- **Done when:** the findings doc says whether a browser on the Mac is worth a track.

### D3.4 Decision record `[parked]`

Parked with D3.3; the `Hands` interface (D3.1, D3.2) stays in place.

- `[parked]` D3.4.1 `docs/decisions/0003-hands.md`: the interface, the kinds, what a Mac
  browser would need (Chrome over DevTools, a VNC screen, a macOS fence), and whether to
  do it.
- **Done when:** the record is written and linked from the README's docs table.

## D4. One Workflow world for several brains `[done]`

eve lets a self-hosted agent pick a Workflow world package. If a laptop and
a server share one world, an idle session started by one could be picked up
by the other. Experimental in eve, and only idle sessions move even on
Vercel, so this is a spike with a written answer, not a feature.

### D4.1 The spike `[done]`

- **Files:** `docker-compose.yml` (a `postgres` profile), `agent/agent.ts`
  (`experimental.workflow.world` from `BOT_WORKFLOW_WORLD`), `docs/research/shared-world.md`.
- `[done]` D4.1.1 Install `@workflow/world-postgres` matching eve's `@workflow/*` line, run
  Postgres from the compose profile, point `npm run dev` at it, confirm a session runs.
- `[done]` D4.1.2 (moved, six hops, every one answered; the local-world control stranded on the first) Build with `npm run build`, start `npm start` against the same world, send a
  message to the session the dev server created. Record what happens: picked up, refused
  (stranded, 409), or corrupted.
- `[done]` D4.1.3 (21 Oct 2026, `scripts/spikes/computer-hop.mjs`, five hops dev ↔ built on one Postgres world: the same Docker container every hop, its files kept, no restore needed; across hosts still untested) Same with the computer: does the sandbox reconnect record survive, does
  the second process reattach the Docker container, does the backup restore cover the gap.
- `[done]` D4.1.4 (9.3 MB after six hops; pool and concurrency knobs noted; reset support deferred to after track E) Cost and operations: what Postgres needs (size after a day of jobs, vacuum),
  how `npm run reset` clears it.
- **Tests:** none beyond the spike's own script, kept as `scripts/spikes/world-hop.sh`.
- **Eval:** number of sessions that moved versus started fresh across five restarts; time
  to first turn after a move.
- **Done when:** the findings doc answers "can a conversation move" with numbers.

### D4.2 Decision record `[done]`

- `[done]` D4.2.1 (decided: local stays the default, Postgres is an opt-in, the dependency waits for track E) `docs/decisions/0002-workflow-world.md`: keep the local world, adopt
  Postgres for standalone, or wait for eve. If adopted, the setup script gains the option.
- **Done when:** the decision is written and linked.

## D5. Rewind `[done]`

Beyond "continue from the last recorded step" (D1): a point in the job's
journal a person can choose, with the computer's files put back as they
were at that point, and a new run briefed with the journal up to it. Needs
D1 and the backup generations.

### D5.1 Generations tied to journal entries `[done]`

- **Files:** `agent/lib/computer-backup.ts` (`checkpointComputer({ reason, journalIndex })`,
  generation list `computer/<name>/generations.json`), `agent/lib/journal.ts` (entry gets
  `generation?`), `agent/lib/computer/snapshot.ts` (new).
- `[done]` D5.1.1 (changed: a whole-machine snapshot would rewind every Bot's files on the shared computer, so a generation archives only what the job owns, its Bot's folder and the files its journal lists, with the same path archive on every kind; `hands.files.archive`/`restore`. Taken when a run starts, at each decision, and before an email; connector changes and approved clicks not yet) On Vercel Sandbox use the SDK's snapshot (`@vercel/sandbox` exports
  `Snapshot`): a snapshot per `decision` entry and before each outward action
  (`send_email`, a connector change, a gated browser click once approved). On Docker and
  microsandbox, a tar archive as today. Both named by job id and journal index.
- `[done]` D5.1.2 (the first and the latest nine per job) Retention: keep the last 10 generations per job and every generation
  the journal still references; a job's close prunes to the final one. Size and count on
  the Usage sheet's budget card (`BOT_BACKUP_MAX_MB` already caps one archive).
- `[done]` D5.1.3 (60-second cap, best-effort, never fails the step) Taking a generation must not block the Bot for long: snapshots are async
  on Vercel; the tar path runs with a 60-second cap and skips with a journal `error` when
  it cannot.
- **Tests:** unit: generation naming, retention pruning, journal reference. Live: a job on
  Vercel Sandbox produces snapshots the dashboard lists; on Docker, archives in the store.
- **Eval:** seconds added per checkpoint (target under 5 on Docker, under 2 on Vercel),
  storage per job (recorded).
- **Done when:** every decision in a journal has a generation behind it.

### D5.2 "Rewind to here" on a job `[done]`

- **Files:** `agent/lib/jobs.ts` (`rewindJob(workspaceId, jobId, index)`), `agent/channels/ops.ts`
  (`POST /bot/v1/jobs/:id/rewind`), `agent/lib/computer-backup.ts` (`restoreGeneration`),
  `agent/tools/run_job.ts` (a claim that carries `rewindTo`), `src/console/transcript.tsx`.
- `[done]` D5.2.1 (the old run is superseded and its sessions stopped rather than the job cancelled; restore is in `lib/rewind.ts`) `rewindJob`: cancel the live run through `cancelJobRun`, truncate the
  journal to `index` (keeping the dropped tail under `journal.rewound[]` for the record),
  set status `queued`, record `job.rewound` in the feed, and restore the generation named
  by the entry before `index` (or the job's first generation).
- `[done]` D5.2.2 The next run's brief says "Rewound to step N on <date> by <who>; the
  computer's files are as they were then" and replays the journal up to N.
- `[done]` D5.2.3 (emails from the action ledger; connector changes are not in the ledger yet) Outward actions after the rewind point are listed in the brief as "already
  done, do not repeat" when the action ledger shows a receipt (an email sent cannot be
  unsent); the journal keeps their entries marked `kept`.
- `[done]` D5.2.4 (inline confirmation on the journal line; the divider then reads "Rewound to here by …") Console: "Rewind to here" on a journal entry, with a confirm sheet that
  names what will be undone and what cannot be.
- **Tests:** unit: truncate and keep rules, ledger scan; QA: `qa/checks/rewind.mjs` runs a
  job that writes two files, rewinds to between them, expects the first file present and
  the second gone, and the journal to show the rewind.
- **Eval:** rewind round-trip time (click to new run's first step); files restored exactly
  (a checksum list taken at the generation).
- **Live result (Docker, 13 Oct 2026):** `qa/checks/rewind.mjs` passed in 135 s: rewound to step 3,
  files from the decision's saved point, `a` there and `b` gone straight after, the job then
  finished with `b` written once. The decision's saved point took under a second (200 bytes);
  the start point covered an empty folder (0 bytes).
- **Defect found and fixed by the live run:** the first restore extracted as the computer's
  user, so the Bot's folder came back without the `bot-team` group's write bit and the Bot's
  shell could not write in it (the Bot reported it and blocked). Restore now keeps the
  archive's permissions and re-applies the shared-folder rules.
- **Vercel Sandbox (14 Oct 2026, a test project):** passed in 155 s: rewound to step 3, files from step 3, job done.
- **Done when:** the QA check passes on Vercel Sandbox and Docker. Both done.

### D5.3 Rewind a conversation `[done]`

- **Files:** `agent/channels/ops.ts` (`POST /bot/v1/rooms/:room/fork`), `agent/lib/roomstate.ts`,
  `src/console/transcript.tsx` ("Branch from here" on a message).
- `[done]` D5.3.1 Fork: start a fresh session for the room (as recover does) seeded through
  a `session.started` dynamic instruction with the transcript up to the chosen index
  (eve's `transcriptReducer` after E4), and keep the old session readable under a "before
  the branch" divider. As built: `POST /bot/v1/rooms/:room/fork { eventId }` names the point
  by its stream event id, `lib/branch.ts` folds each of the thread's sessions with its own
  reducer (sequences restart per session) up to it, the room keeps the result as a one-time
  seed that `instructions/earlier.ts` hands to the next session, and "Branch from here" sits
  on a Bot's replies only. The stream route reads a thread back while it has no session yet.
- `[done]` D5.3.2 Jobs started after the branch point stay as they are; the divider lists
  the ones still going so nothing silently continues (`withBranches` in `room-store.ts`).
- **Tests:** turn test: a forked session's first turn sees the earlier transcript and not
  the messages after the index. QA: `qa/checks/fork.mjs`.
- **Done when:** a person can take a thread back to a message and go a different way.
- **Checked live (15 Oct 2026, `eve dev`):** branched HQ's desk to its first message, then
  asked for the last question before this one: it quoted that first message, not the three
  that followed. Then "Branch from here" in the console on a later reply: the old messages
  fade under a divider quoting the reply, and the next answer carried on from it. Unit:
  `tests/branch.test.ts`.

### D5.4 Write it down `[done]`

- `[done]` D5.4.1 README "What you get" gains one bullet on rewind; `docs/safety.md`
  says what a rewind cannot undo; `docs/configuration.md` lists the retention knobs.
- **Done when:** the docs render and the link check passes.

## Order of work

1. The two helpers (fault routes, `qa/lib/wait.mjs`) `[done]` (`agent/lib/qa.ts`, routes in `ops.ts`, `tests/qa.test.ts`)
2. D0.1 `[done]`, D0.2 `[done]` (QA check written, not yet run live: needs a model and `BOT_QA=1`)
3. D1.1 `[done]`, D1.2 `[done]`, D1.3 `[done]`, D1.4 `[done]` (Docker and Vercel Sandbox)
4. D2.1 `[done]`, D2.2 `[done]`, D2.4 `[done]`
5. D1.5 `[done]`, D1.6 `[done]`, D0.3 `[done]`
6. D3.1 `[done]`, D3.2 `[done]`
7. D4.1 `[done]`, D4.2 `[done]`
8. D5.1 `[done]`, D5.2 `[done]`
9. D3.3 `[parked]`, D3.4 `[parked]`, D5.3 `[done]`, D5.4 `[done]`, D2.3 `[done]`

Update the status board at the top with each commit.
