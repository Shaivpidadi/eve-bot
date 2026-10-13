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

