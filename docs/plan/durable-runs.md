# Plan: runs that outlive their machine

The build plan for [brain-hands-durable-runs.md](../research/brain-hands-durable-runs.md).
It covers the six tracks that research produced (D0 to D5). The eve 0.78
upgrade (track E in [backlog.md](backlog.md)) comes first because D1 edits
`run_job.ts`, which the upgrade rewrites.

## How to read this file

- Every task and subtask carries one tag: `[to-do]`, `[in-progress]`, `[done]`.
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
| E. eve 0.78 upgrade (prerequisite, see backlog) | [to-do] | 0/7 |
| D0. Stranded runs | [to-do] | 0/3 |
| D1. The job record as the session log | [to-do] | 0/6 |
| D2. A workspace that follows its owner | [to-do] | 0/4 |
| D3. Thin hands | [to-do] | 0/4 |
| D4. One Workflow world | [to-do] | 0/2 |
| D5. Rewind | [to-do] | 0/4 |

## D0. Stranded runs `[to-do]`

A code change under `eve dev` quarantines active Workflow runs; a standalone
rebuild does the same. The job's lease then sits unexpired for up to 20
minutes, and the watchdog only runs daily by default. Vercel is not affected
(the old deployment keeps the run alive), so every rule below applies only
when the Workflow world is local.

### D0.1 Tell a job which build holds its run `[to-do]`

- **Files:** `agent/lib/types.ts` (`JobLease.build?: string`), `agent/lib/jobs.ts`
  (`claimJob`, `renewLease`), `agent/lib/build.ts` (new: `buildId()`).
- `[to-do]` D0.1.1 `buildId()` returns a stable id for the running code: `VERCEL_DEPLOYMENT_ID`
  on Vercel, else a hash of `package.json` version plus the `.eve/dev-runtime` generation
  under `eve dev`, else the `.output` build stamp. Unit test: same process, same id;
  different stamp, different id.
- `[to-do]` D0.1.2 `claimJob` and `renewLease` write `lease.build = buildId()`. Older
  records without it are treated as "unknown build". Unit test on the lease shape.
- **Done when:** every new `run` and `wait` lease names its build.

### D0.2 Treat a lease from another build as lapsed on local worlds `[to-do]`

- **Files:** `agent/lib/jobs.ts` (`dueJobs`, a `leaseIsLive(lease)` helper),
  `agent/schedules/tick.ts`, `scripts/start.mjs`, `agent/lib/world.ts` (new: `worldIsLocal()`).
- `[to-do]` D0.2.1 `worldIsLocal()`: true unless `VERCEL=1` or `experimental.workflow.world`
  names a shared world (read from `agent.ts` config through an env mirror
  `BOT_WORKFLOW_WORLD`). Unit test.
- `[to-do]` D0.2.2 `leaseIsLive`: on a local world a `run`, `wait`, `dispatch` or `signoff`
  lease whose `build` differs from `buildId()` is lapsed at once; elsewhere, the `until`
  clock rules. `dueJobs` uses it. Unit tests: four lease kinds × same build, other build,
  unknown build, Vercel.
- `[to-do]` D0.2.3 A sweep at start: `npm start` and `eve dev` trigger one tick pass
  60 seconds after boot (`BOT_TICK_ON_START=off` disables). Under `eve dev` the
  schedule runner is off, so the pass is a direct call to the tick's dispatcher through
  the dev schedules route the README already documents.
- `[to-do]` D0.2.4 The feed records `job.stranded` with the old build and the new one, so
  the thread says "the server restarted with new code; Atlas is picking the job up again".
- **Tests:** unit as above; QA `qa/checks/stranded.mjs`: with `BOT_QA=1`, crash a job's run,
  bump the build stamp through `POST /bot/v1/qa/build/bump`, and expect the job
  re-dispatched within 90 seconds with a `job.stranded` feed line.
- **Eval:** time from rebuild to re-dispatch, measured by the QA check, recorded here.
  Target: under 2 minutes locally (was: up to 20 minutes plus a day).
- **Done when:** a rebuild mid-job re-runs the job within two minutes and says so.

### D0.3 Stranded conversations `[to-do]`

Depends on E4 (eve 0.76's `409 session_stranded` and `ctx.session.predecessor`).

- `[to-do]` D0.3.1 The console's recover path treats `409 session_stranded` like a wedged
  room: fresh session, message re-sent, thread note.
- `[to-do]` D0.3.2 A `session.started` dynamic instruction folds the predecessor's transcript
  (eve's `transcriptReducer`) into the new session, capped at the last 40 messages, so a
  recovered room remembers its conversation and not only Memory.
- **Tests:** turn test: a session with a predecessor sees the earlier transcript in its
  first turn's instructions. QA: `qa/checks/recover.mjs` asks a question, strands the room
  through the QA route, asks a follow-up that needs the earlier answer, and expects it answered.
- **Done when:** a recovered thread answers a follow-up that needs what was said before.

## D1. The job record as the session log `[to-do]`

A fresh run starts from the brief. After this track it starts from where the
last run got to. The journal is the portable half of Anthropic's session
log: not the model's messages (those stay in eve's Workflow journal) but the
facts a run produced, written into the job record under the fence.

### D1.1 The journal `[to-do]`

- **Files:** `agent/lib/types.ts` (`JournalEntry`, `Job.journal`), `agent/lib/jobs.ts`
  (`appendJournal`), `agent/lib/journal.ts` (new: shapes, cap, rendering helpers),
  `tests/journal.test.ts`.
- `[to-do]` D1.1.1 Shape: `{ at, runToken, kind, text, data? }` with kinds `progress`,
  `decision`, `page` (`url`, `title`, `targetId`), `file` (`path`, `bytes`), `artifact`
  (`id`, `name`), `asked` (`requestId`, `reason`, `answer?`), `handover` (`note`), `error`
  (`tool`, `message`). `text` is one line for a person; `data` is for the next run.
- `[to-do]` D1.1.2 `appendJournal(workspaceId, jobId, sessionId, entry)` through
  `patchJobAsRun`, so a superseded run writes nothing and a replayed write is a no-op
  (same `runToken` + `at` + `kind` + `text` already present returns `null`).
- `[to-do]` D1.1.3 Cap: keep the first 20 entries and the last 180; the drop writes one
  `progress` entry "N earlier steps folded" so the gap is visible. Unit tests: append, dedupe
  on replay, cap keeps head and tail, fenced run refused.
- `[to-do]` D1.1.4 Migration: older jobs have no `journal`; readers treat `undefined` as `[]`.
  Unit test on `getJob` of an old record.
- **Done when:** a job's record shows the path a run took, in order, with no duplicates
  after a replay.

### D1.2 The tools write it `[to-do]`

- **Files:** `agent/subagents/teammate/tools/log_progress.ts`, `write_file.ts`,
  `save_artifact.ts`, `request_takeover.ts`, `page_*.ts` through `lib/browser.ts`
  (`refreshScreen` and the navigation path), `finish_job.ts`.
- `[to-do]` D1.2.1 `log_progress` writes `progress` (keeps the feed record too).
- `[to-do]` D1.2.2 The browser layer writes `page` once per navigation (new URL for the run's
  tab), not per action. Unit test with a fake `browser()` that returns the same URL twice.
- `[to-do]` D1.2.3 `write_file` writes `file` for paths under `/workspace/bots` and
  `/workspace/shared`; scratch under `/workspace/sessions` is skipped.
- `[to-do]` D1.2.4 `save_artifact` writes `artifact`; `request_takeover` writes `asked` and,
  when the person hands back, `handover` with the note.
- `[to-do]` D1.2.5 Tool failures the teammate sees (a browser action refused, a command that
  exits non-zero) write `error`, capped at 20 per run so a loop cannot flood the record.
- **Tests:** unit per tool with the journal fake; turn test that one real teammate turn with
  a stubbed browser leaves `page` then `progress` in order.
- **Done when:** a finished job's journal reads as a short diary a person could follow.

### D1.3 The brief replays it `[to-do]`

- **Files:** `agent/lib/brief.ts`, `agent/lib/journal.ts` (`renderJournal`),
  `agent/subagents/teammate/instructions.md`, `tests/brief.test.ts`.
- `[to-do]` D1.3.1 `renderJournal(entries, { limit })` renders "## Where the last run got to":
  the last 30 entries as one line each, then "Open page: <url>", "Files written: …",
  "Asked and answered: …". Empty journal renders nothing.
- `[to-do]` D1.3.2 `renderBrief` includes it when `job.attempts > 1` or `job.feedback` is set,
  after the sent-back section and before the result-so-far.
- `[to-do]` D1.3.3 Teammate instructions: "If the brief says where the last run got to, open
  that page and continue; do not redo listed steps unless the page says they did not land."
- `[to-do]` D1.3.4 The run's first `progress` entry after a resume says "continued from
  step N" with N the journal length at claim, and `run_job` records `resumedFrom: N` on the
  job for the console.
- **Tests:** unit: render with 0, 5, 300 entries; brief with and without journal. Turn
  test: a teammate briefed with a journal whose last entry is `page` calls `page_get` for
  that URL first (stub model scripted to follow instructions, asserting the tool order).
- **Done when:** a re-run's brief carries the diary and the Bot's first action continues it.

### D1.4 Prove it: crash and continue `[to-do]`

- **Files:** `agent/channels/ops.ts` (the `BOT_QA=1` crash route), `qa/checks/resume.mjs`,
  `qa/lib/wait.mjs`.
- `[to-do]` D1.4.1 The crash route: ends the run's teammate session (`attachSession(...).cancel`
  then reset), lapses the lease (`until` = now) without touching status, records
  `job.crashed` in the feed. Refused with 404 unless `BOT_QA=1`.
- `[to-do]` D1.4.2 `qa/checks/resume.mjs` with `QA_JOBS=1`: assign a three-step job (open a
  known page, write a file, log a line), wait for two journal entries, crash it, expect a new
  run whose brief carried the journal (read `resumedFrom` on the job), expect the job to
  close once, and expect the file written once (journal has one `file` entry for the path).
- `[to-do]` D1.4.3 Same check under a watchdog tick rather than a manual `run_job`, so the
  dispatch path is covered.
- **Eval:** redo ratio = journal entries after resume that repeat a `page` URL or `file` path
  from before, divided by entries before the crash. Computed by `npm run metrics -- --resume`
  (new flag reading `resumedFrom`). Record before (no journal: ratio 1.0 by definition) and
  after. Target: under 0.2 on the QA job, under 0.4 on a real research job.
- **Done when:** the QA check passes on Vercel Sandbox and on Docker, and the ratio is recorded.

### D1.5 A note to self `[to-do]`

- **Files:** `agent/subagents/teammate/tools/log_progress.ts` (a `kind: "decision"` input),
  `instructions.md`.
- `[to-do]` D1.5.1 `log_progress` takes `kind: "progress" | "decision"`; decisions are rendered
  first in the brief's replay. Instructions ask for a decision entry when the plan changes
  or a step is skipped on purpose.
- `[to-do]` D1.5.2 Jev watch: the existing close review records whether the journal's
  decisions match the result's summary (observation only, no gate).
- **Eval:** share of jobs with at least one `decision` entry; Jev agreement rate. Recorded,
  no target yet.
- **Done when:** the brief's replay leads with why, then what.

### D1.6 The console shows it `[to-do]`

- **Files:** `src/console/transcript.tsx` (job card), `src/console/panel.tsx`,
  `agent/channels/ops.ts` (`GET /bot/v1/jobs/:id` includes `journal`, `resumedFrom`).
- `[to-do]` D1.6.1 The job card gets a "Steps" disclosure: the journal as a timeline with
  icons per kind, the `page` entries as links, `error` entries muted.
- `[to-do]` D1.6.2 A resumed run shows a divider "continued from step N after a restart"
  at the right place.
- `[to-do]` D1.6.3 QA `qa/checks/jobs.mjs` asserts the job route returns `journal` and the
  timeline order matches.
- **Done when:** a person can read what a Bot did while they were away from the card alone.

## D2. A workspace that follows its owner `[to-do]`

Runs do not move (they live in the Workflow world). Everything else can:
documents and bytes under the store prefix. After this track a workspace
exported from Vercel opens on a laptop with its roster, jobs, memory,
connectors and backups, and open jobs are picked up by the watchdog there.

### D2.1 Export `[to-do]`

- **Files:** `scripts/export.mjs`, `agent/lib/store/transfer.ts` (new), `tests/transfer.test.ts`,
  `package.json` (`"export": "node scripts/export.mjs"`).
- `[to-do]` D2.1.1 `transfer.ts`: `listAll(kv)` walks every key under the prefix (docs and
  bytes; `kv.list` covers both, bytes read with `getBytes`), `exportTo(kv, writable)`
  streams a tar.gz: `manifest.json` (prefix, store driver, eve-bot version, exported at,
  counts) then one file per key under `docs/` or `bytes/`, keys percent-encoded.
- `[to-do]` D2.1.2 Sealed connector keys and OAuth tokens are included as stored (they are
  sealed to the workspace secret, which is an env var the owner carries; the manifest says
  so). `--no-secrets` leaves them out.
- `[to-do]` D2.1.3 `scripts/export.mjs --out <file> [--workspace <id>] [--no-secrets]` reads
  the same env as the server (`.env`, `.env.local`, or pulled Vercel env), prints counts.
- **Tests:** unit: memory store with 50 docs and 3 byte objects round-trips through a tar
  buffer with identical bytes; a key with `/` and `%` in it survives. Keys outside the
  workspace are left out when `--workspace` is given.
- **Done when:** `npm run export -- --out ws.tgz` on a Vercel-linked checkout produces an
  archive whose manifest counts match a `kv.list` of the store.

### D2.2 Import `[to-do]`

- **Files:** `scripts/import.mjs`, `agent/lib/store/transfer.ts` (`importFrom`), tests.
- `[to-do]` D2.2.1 `importFrom(kv, readable, { onConflict: "replace" | "skip" | "fail", dryRun })`
  writes every entry; `dryRun` prints what would change. Version mismatch between archive
  and code is a warning, not a refusal (the store reads old shapes lazily).
- `[to-do]` D2.2.2 Jobs with an open lease are rewritten with `lease: null`, `status` kept,
  and a `job.moved` feed line, so the watchdog re-dispatches them and D1's journal lets the
  new run continue. Rooms' session ids are cleared (`roomstate`), so the console starts
  fresh sessions and says so once per room.
- `[to-do]` D2.2.3 Backup archives are imported but the manifest's `arch` and kind rules in
  `computer-backup.ts` still decide whether they restore onto the new computer.
- `[to-do]` D2.2.4 `scripts/import.mjs --in <file> [--dry-run] [--on-conflict …]`.
- **Tests:** unit: export from memory, import into fs, every doc equal; conflict modes;
  open-lease rewrite; dry run writes nothing. QA: `qa/checks/transfer.mjs` runs on a
  scratch deployment: seed roster and memory, export, `npm run reset`, import, expect the
  roster and memory back and the open job re-dispatched.
- **Eval:** fidelity = docs equal after round trip / docs exported (target 1.0), and time to
  first re-dispatch after import (target under one tick).
- **Done when:** a workspace moves Vercel → laptop → Vercel with nothing lost but live runs.

### D2.3 Route for hosted deployments `[to-do]`

- `[to-do]` D2.3.1 `GET /bot/v1/export` (console token, `BOT_EXPORT=on`) streams the same
  archive, so an owner without a local checkout can still take their workspace out.
- `[to-do]` D2.3.2 The Usage sheet's footer gets "Export workspace".
- **Tests:** QA: the route's archive imports cleanly with the script.
- **Done when:** the export is reachable from the console behind the gate.

### D2.4 Write it down `[to-do]`

- `[to-do]` D2.4.1 `docs/updating.md` gains "Moving a workspace": what moves, what does
  not (live runs, the computer unless its backup is current), and the two commands.
- **Done when:** the doc exists and the link check passes.

