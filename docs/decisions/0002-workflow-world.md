# 0002 — Workflow world: offer Postgres for standalone, keep the local world as the default

- Status: accepted (13 Oct 2026, D4.2)
- Scope: where eve's Workflow state (sessions, runs, steps, parked waits) lives on a
  self-hosted server. Vercel is unaffected: it uses Vercel Workflow.

## Context

On the default local world a session belongs to the code generation that
started it; a rebuild or a move to another process strands it (D0 handles the
jobs; conversations restart with Memory only). The spike in
[../research/shared-world.md](../research/shared-world.md) showed a Postgres
world carrying one session across six hops between `npm run dev` and a built
`npm start`, while the local world stranded it on the first hop.

## Decision

1. Keep the local world as the default. It needs nothing installed, and a
   standalone server that never changes code loses nothing.
2. Support a Postgres world as an opt-in for standalone servers that want
   conversations to survive rebuilds or to move between machines:
   `BOT_WORKFLOW_WORLD=@workflow/world-postgres` and `WORKFLOW_POSTGRES_URL`.
   `agent/agent.ts` passes the name to eve; D0's stranded-lease rule already
   treats a named world as shared.
3. Do not add the package to `package.json` yet. eve marks the option
   experimental, the package must be pinned to eve's exact `@workflow/*`
   line, and the eve upgrade (track E) moves that line. Re-evaluate after E:
   then add it as an optional dependency, a `postgres` compose profile, a
   setup step, and `npm run reset` support.

## Consequences

- Until then, opting in means `npm install --no-save
  @workflow/world-postgres@<version matching eve>` and running the bootstrap.
- Track D2's export does not cover Workflow state; a moved store plus a
  shared world is the full move.
