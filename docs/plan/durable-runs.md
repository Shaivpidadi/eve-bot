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

