# Spike: one Workflow world for several processes

13 Oct 2026, eve 0.58.1, `@workflow/world-postgres` 5.0.0-beta.42 (the
release built on the same `@workflow/world` 5.0.0-beta.35 eve bundles; the
npm `latest` and `beta` tags point at incompatible lines). Plan item D4.1.

## Question

Can a conversation started by one server process be continued by another
after a code change? On the default local world the research said no: eve
runs one code generation at a time, and a session from another build is
stranded.

## Setup

- Postgres 16 in a throwaway container, schema created with
  `npx --package=@workflow/world-postgres bootstrap`.
- `BOT_WORKFLOW_WORLD=@workflow/world-postgres` selects it through
  `agent/agent.ts` (`experimental.workflow.world`), with
  `WORKFLOW_POSTGRES_URL` pointing at the container.
- `EVE_MOCK_AUTHORED_MODELS=1`, so turns are answered by eve's mock model:
  the question is whether a turn runs, not what it says.
- A scratch store (`BOT_STORE=fs`, its own `BOT_DATA_DIR`).
- `scripts/spikes/world-hop.sh` starts one server (`npm run dev`, or
  `npm start` on a build made with the same environment), sends one message
  to HQ's desk, waits for the answer, reads the room's stream, and stops.

## Results

Postgres world, alternating between the dev server (a new code generation
each start) and the built server:

| Hop | Server | Answered | Time to answer | Turns on the stream | Sessions started |
| --- | --- | --- | --- | --- | --- |
| 1 | dev | yes | under 15 s (first boot) | 1 | 1 |
| 2 | built | yes | under 15 s | 2 | 1 |
| 3 | dev | yes | 5.1 s | 3 | 1 |
| 4 | built | yes | 5.1 s | 4 | 1 |
| 5 | dev | yes | 5.1 s | 5 | 1 |
| 6 | built | yes | 5.1 s | 6 | 1 |

Every hop continued the same session (`wrun_01M4VDN5XF34YJFR4ER4MW5RM8`):
one `session.started` on the stream, one more turn each time. The 5.1 s
includes the check's one-second polling and the mock model.

Control, default local world, the same dev-to-built hop:

| Hop | Server | Answered | Notes |
| --- | --- | --- | --- |
| 1 | dev | yes, 6.3 s | |
| 2 | built | no, gave up at 240 s | message accepted, no turn; the built server's log shows "Agent workflow failed" (`USER_ERROR`) |

After six hops the database held 2 workflow runs and 54 events, 9.3 MB
including the schema. Graphile Worker warns that its pool (10) is smaller
than its concurrency (50); `WORKFLOW_POSTGRES_WORKER_CONCURRENCY` and
`WORKFLOW_POSTGRES_MAX_POOL_SIZE` set them.

## What it means

- **A conversation can move between processes, and across code changes,
  when they share a Postgres world.** That is line 2 of the research for the
  brain: a laptop and a server pointed at the same database continue the
  same sessions.
- The store must be shared too (or moved, D2), since jobs and rooms live
  there. The spike used one store for both processes.
- Not tested here: the computer. A sandbox's reconnect record lives in the
  world, so on the same host the Docker container is found again by name;
  across hosts the computer is a different machine, and the backup restore
  (and the kind rule from D3.2) decides what follows.
- Not tested: a run in the middle of a turn when its process dies (eve
  re-runs the interrupted step from the world, which is the point), and two
  processes serving the same world at once (Graphile Worker is built for
  it; eve's handoff rules were not exercised).
- Cost: one Postgres, which a standalone server can run in the compose file.
  `npm run reset` would need to drop the schema too.

## Caveats

- eve marks the world option experimental. The Postgres package must match
  eve's bundled `@workflow/*` line exactly; an unpinned install picks an
  incompatible one. Upgrading eve (track E) means re-pinning it.
- The mock model answers instantly. A real turn's durability across a
  process death mid-step is eve's documented behaviour, not measured here.
