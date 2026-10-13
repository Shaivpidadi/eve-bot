# Development

```bash
npm run dev          # console and agent together, http://localhost:3000/bot
npm run dev:https    # the same over TLS, for the live screen from another device
npm run agent:dev    # the agent alone, with eve's terminal UI
npm test             # vitest over tests/
npm run typecheck && npm run build
npm run reset        # back to zero: threads, roster, jobs, memory; --computer for a fresh machine too
```

Schedules do not fire under `npm run dev`; trigger the watchdog with
`curl -X POST localhost:3000/eve/v1/dev/schedules/tick`. A thread started under
the dev server cannot continue under `npm start`; the console offers Start over.

To develop against a Vercel project, pull its Sandbox and Gateway credentials:

```bash
npx vercel link && npx vercel env pull
```

## Layout

```
agent/                      HQ: agent.ts, instructions.md, tools/, schedules/, hooks/
agent/subagents/teammate/   the Bot that does the work: its tools, browser gate, and hooks
agent/lib/                  jobs, runs, budget, actions, memory/, store drivers, computer, pricing, search
agent/channels/ops.ts       the console API
src/console/                the console
src/site/                   the public front door
scripts/                    setup, build, start, and the Docker wrapper for Chrome's sandbox
tests/                      vitest
qa/                         the suite that drives a running deployment
docs/                       this folder, and decisions/ for design records
```

Swapping storage means implementing four methods in `agent/lib/store/`; the
reasoning behind the current store is in
[decisions/0001-state-store.md](decisions/0001-state-store.md).

## A second opinion on small decisions

With an AI Gateway key, Bot can ask [Jev](https://vercel.com/ai-gateway/models/jev)
the questions that are decisions rather than writing: is this page a sign-in
wall, does this result actually meet the brief, is this exchange worth
remembering. It answers as a probability, priced per input token. Memory
capture acts on its answers; elsewhere each answer is filed next to what the
system did anyway:

```bash
npm run jev:report          # what Jev would have decided, against what happened
```

Turn it off with `BOT_JEV=off`. It is off on its own wherever the Gateway
cannot be reached, so a standalone server on your own models never depends on
it.

## Are the Bots getting better

Every change is supposed to make jobs finish more often, with fewer
interruptions. That is measurable from what the Bots already record:

```bash
npm run metrics              # verified vs recovered closes, interruptions, how long a job takes
npm run metrics -- --days 7
```

Run it before and after a change, on the same kind of work. What a job cost
is on the job itself and in its Bot's panel, as the provider priced it; the
report leaves it out rather than average numbers from different models.

## Bots testing Bots

`npm test` covers the pure parts. The things that actually break, a job that
closes without doing the work, an approval that does not hold, a cancelled job
that comes back, need a running deployment, so there is a suite that drives
one over its own console API:

```bash
QA_URL=https://staging.example QA_TOKEN=… npm run qa    # free, no model calls
QA_JOBS=1 … npm run qa                                  # also runs real jobs
```

With `BOT_QA=1` set on that deployment, the suite can also crash a job's run
(`POST /bot/v1/qa/jobs/:id/crash`) and make the computer look replaced
(`POST /bot/v1/qa/computer/replace`), which is how the durable-run checks
watch a recovery. The routes do not exist without the variable.

It hires bots, writes memory and (with `QA_JOBS=1`) runs jobs, so point it at a
deployment with its own computer and its own data, never at the one you work
in. Failures are written to `.qa/` with what was expected and what the
deployment actually answered.

## Pull requests

CI runs tests, types, and a full build on every pull request and every branch
push; `main` is left to Vercel, which builds each push itself. Commit subjects
follow Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`, `test:` …).
