# Plan: what Vercel Ship SF (15 Oct 2026) adds to eve-bot

Branch: `feat/ship-26` (from `main` at 0.4.0). This file is
the live tracker: tags change in the same commit as the work.

## Context

Vercel shipped a batch of agent infrastructure at Ship SF. eve-bot is deliberately Vercel-native
(memory: vercel-maxxing), and several of our hardest, most failure-prone pieces are things Vercel now
offers as products: the team computer's first-boot install (it broke on Docker this week), backup
and restore of the computer by tar to Blob, "nothing runs between requests" workarounds (the
server POSTing to itself, a daily cron), and hand-rolled connector OAuth. The goal is to adopt
what removes our own fragile code or unlocks something users want, without breaking two hard rules:
**local mode keeps working without Vercel** (memory: local-flow-direction) and **one shared team
computer** (memory: one-shared-computer).

Verified facts that shape the plan (from Vercel/eve docs, 16 Oct):
- Sandboxes can start from a custom image in Vercel Container Registry (public beta since June,
  linux/amd64, no ENTRYPOINT run). eve 0.79.1 already takes `image` on Vercel and
  `DockerSandbox.dockerfile()` / `agent/sandbox/Dockerfile` locally. We use neither.
- Drives (GA): one read-write mount at a time, read-only `snapshot()` mounts, survive sandbox stop,
  region-pinned (iad1 default), 1 GiB on Hobby. **Must mount outside `/workspace`** (eve owns it).
  The `@vercel/sandbox` 3.2.2 bundled in eve has no `fork()`. eve's Docker sandbox has no mounts.
- Daemons (beta): container workers from `vercel.json` `daemons`, **production only, no previews**,
  no inbound traffic, OIDC token per instance; `vercel dev` skips them.
- Connect (GA): `@vercel/connect/eve` gives `defineMcpClientConnection({ url, auth: connect('linear/x') })`,
  per-user grants. MCP Events (beta): webhook to `/eve/v1/hooks/:connection`, production or a custom
  environment with a domain, **no replay** (we need our own durable inbox).
- AI Gateway: budgets per team/project/key/user (HTTP 402 `quota_for_entity_exceeded`); per-request
  `providerOptions.gateway.zeroDataRetention: true` (Pro+) and
  `inferenceRegion: { scope: 'zone', geoRegion: 'us' }` (fails rather than running elsewhere).
- Passport: GA but **Enterprise only**; verified identity via `@vercel/passport` `getIdentity()`.
- Free stealth model `stealth/cat-jam`: tools + JSON schema, **no ZDR**. Token Pass: $30 for $80 of
  GLM 5.3 / Kimi K3, Pro, early access.

## The features, why, and what they give us

| # | Feature | Why | Benefit to eve-bot | Priority |
|---|---|---|---|---|
| F1 | **Team computer from a prebuilt image** (Dockerfile → VCR on Vercel, `DockerSandbox.dockerfile()` locally) | Chrome, the desktop and VNC are apt-installed at first boot by a background script; a template saved mid-install broke every Docker machine this week, and `prepare` still swallows install errors | First job no longer waits minutes; the whole install/self-heal/mirror class of bugs goes; same image locally and on Vercel; egress can default tighter (the open default exists only for apt) | **P0** |
| F2 | **Team computer on a Vercel Drive** | `/workspace` survives today only by tar-to-Blob every 10 min and a restore onto a replacement machine (`computer-backup.ts`, 512 MB cap); browser profiles are excluded, so sign-ins can be lost | Work and sign-ins survive a lost machine with nothing lost since the last backup; no 512 MB cap; backups become a slow off-site copy; restores are a mount, not a tar | **P1** (Vercel only; local keeps tar) |
| F3 | **Vercel Daemons for background work** | Outbox delivery, due-job dispatch, the sweep, the idle-browser reaper and computer billing run on console polls, a daily cron (Hobby limit) and the server calling itself (`self.ts`) | Wake-ups, teammate notes and stranded jobs move within ~30 s with no console open; idle Chrome stops on time; the self-POST path becomes a fallback | **P1** (production only) |
| F4 | **Vercel Connect as a connector auth kind** | `connector-oauth.ts` hand-rolls discovery, dynamic registration, PKCE and refresh, and stores sealed tokens | One-click connectors from Connect's catalog with grants per person; less OAuth code to own; our gates, approvals and reviewed reads stay | **P2** |
| F5 | **Event-driven Bots (MCP Events)** | Bots act only when asked or on a schedule | "When a new Linear issue is assigned to me, triage it": Bots react to events from connected apps, through our durable outbox | **P2** (after F4) |
| F6 | **AI Gateway controls**: budgets backstop, Zero Data Retention, US-only inference | Spend caps are ours only; ZDR is approximated by a hand-picked model list; a Gateway 402 is not recognised | A hard Gateway-side ceiling behind our per-run caps; one setting for ZDR and one for US-only on every model call; a clear message instead of a raw error | **P1** (small) |
| F7 | **Free models and Token Pass** | Local runs on Nemotron, which fails memory's structured output | Try `stealth/cat-jam` (free, tools + JSON) as the local memory model; document Token Pass as a cheaper paid option | **P2** (small) |
| F8 | **Vercel Passport sign-in (optional)** | On Vercel the console trusts Deployment Protection and decodes an unverified JWT for the name | Verified identity for Enterprise teams; first step to more than one person per workspace | **P3** (Enterprise only) |

Not adopted: Python, Vercel Services, BYOC on AWS, Vercel Agent (repo ops, not product), Shopify.
Already in use: eve, AI SDK 7.

## Task distribution

Tags: `[to-do]`, `[in-progress]`, `[done]`, `[parked]`. One commit per task, Conventional Commits,
no co-author line. Each task names files, tests, and "done when". Statuses below are all `[to-do]`.

### V0. Ground truth spikes `[to-do]` (do first; each ends in a short findings note in this file)
- `[to-do]` V0.1 **Image spike**: build the computer Dockerfile, push with `vercel vcr build docker . --push`, start a
  sandbox from it via eve `VercelSandbox.environment({ image })` on a scratch preview; confirm eve's `prepare` snapshot
  still layers on top, `image_not_ready` handling, cold-start time vs today.
- `[to-do]` V0.2 **Drive spike**: `Drive.getOrCreate`, mount at `/team` through eve `environment.open({ mounts })` in
  `team-computer.ts`; confirm: survives sandbox stop and delete; resume does not need the mount re-passed; Chrome profile
  on the drive works (Singleton locks, speed); whether the bundled `@vercel/sandbox` version needs a bump for `fork()`.
- `[to-do]` V0.3 **Daemon spike**: a 20-line daemon in this project that loops `dispatchDue` + `deliverOutbox` against
  the store with its OIDC token; confirm it reaches Blob/store and AI Gateway, and its cost on Hobby (10 CPU-h/month).
- `[to-do]` V0.4 **Connect spike**: one Connect connector (Linear) through `@vercel/connect/eve` in the teammate's
  connection set; confirm our `approval.request` / `approval.response` hooks still fire with Connect auth.
- `[done]` V0.5 Check `vercelControl()` in `agent/lib/computer/control.ts`: it uses `COMPUTER_NAME`, not
  `machineName()` (the Docker bug we just fixed). Fix if eve can name a Vercel sandbox differently.
  **Finding:** it can, and does: eve names every sandbox it creates `eve-sbx-vercel-<identity>` (`vercelSessionName`).
  Our test project only worked because it adopted a 0.58 machine named `bot-computer`; a fresh deployment, or a
  replaced machine, would have had no live view, no takeover and no runtime charge (`computer-spend.ts` had the same
  lookup). Both now read the name from the machine record, in a store-only `lib/machine.ts` so workflow code that
  reaches the charge never loads eve's sandbox providers.
- **Done when:** each spike has a findings line here and a go/no-go for its track.

### V1. Team computer from a prebuilt image (F1) `[to-do]`
- `[to-do]` V1.1 `agent/sandbox/Dockerfile`: Ubuntu base matching eve's, `PACKAGES` from `computer/script.ts`, Chrome
  `.deb`, agent-browser, the `bot` user and `bot-team` group, `/usr/local/lib/bot-computer/bot_shell.py`. Multi-arch
  build locally (arm64 Mac), linux/amd64 for VCR.
- `[to-do]` V1.2 `computer-config.ts`: Docker/microsandbox use `.dockerfile()`; Vercel uses `image: BOT_COMPUTER_IMAGE`
  (a VCR ref), falling back to today's install when unset, so a fresh clone still works.
- `[to-do]` V1.3 `sandbox/sandbox.ts` `prepare()`: with an image, only `mkdir` the paths; without one, keep the install
  but **fail the template on an incomplete install** instead of `console.warn` (closes the mid-install template hole
  even before images).
- `[to-do]` V1.4 `script.ts` / `runtime.ts`: keep `installed()` as a health check; the install path, mirror rewrite and
  `untilInstalled` remain only for the no-image fallback. `cmd_isolate` keeps only the per-boot fence.
- `[to-do]` V1.5 CI: build the computer image on PRs (no push); a release workflow pushes to VCR and records the digest.
- `[to-do]` V1.6 Docs: `docs/configuration.md` (`BOT_COMPUTER_IMAGE`), `.env.example`, README "computer" section.
- **Tests:** unit for the config branch (image vs fallback); `tests/hands.test.ts` still green; build test of the Dockerfile in CI.
- **Done when:** a fresh Docker computer and a fresh Vercel computer run a browser + shell job with no apt step, and the
  first job's start time is recorded here (before/after).

### V2. Team computer on a Vercel Drive (F2) `[to-do]` (Vercel only; depends on V0.2)
- `[to-do]` V2.1 Decide the layout from V0.2: drive at `/team` with `/workspace/{shared,bots,downloads,.computer}` as
  symlinks or bind targets, so every path Bots know stays the same. `sessions` and `attachments` stay off the drive.
- `[to-do]` V2.2 `team-computer.ts`: `Drive.getOrCreate({ name: COMPUTER_NAME, region })` and pass `mounts` on start;
  record the drive in `machine.json`; a replaced machine mounts the same drive.
- `[to-do]` V2.3 `computer-backup.ts`: when the computer's kind has a persistent workspace, skip restore and make the
  backup a slow off-site copy (hourly or on demand); Docker and microsandbox keep today's tar path unchanged.
- `[to-do]` V2.4 `kinds.ts`: `Capabilities.persistentWorkspace`; `describeKind` and the panel caption say so.
- `[to-do]` V2.5 Rewind (`generations.ts`) stays per-job tar (a whole-drive point would rewind other Bots' work, per D5.1);
  revisit only if per-Bot drives become cheap.
- `[to-do]` V2.6 Export/import (`lib/store/transfer.ts`): a Drive-backed workspace exports by taking one backup first.
- `[to-do]` V2.7 Docs: configuration, `docs/updating.md`, `docs/safety.md` (what survives what).
- **Tests:** unit for the kind branch in backup/restore; QA `computer/replace` check on a preview: replace the machine,
  next job finds its files and sign-ins.
- **Done when:** on a preview, deleting the sandbox loses nothing written before it, browser sign-ins included.

### V3. Background work on Vercel Daemons (F3) `[to-do]` (production only; depends on V0.3)
- `[to-do]` V3.1 `daemon/` entry + Dockerfile: a loop every 30 s doing `dispatchDue`, `deliverOutbox`, `reapIdleScreens`,
  `chargeComputerRuntime`, `repairAllReservations` (the tick's work), with its own throttles and a graceful SIGTERM.
- `[to-do]` V3.2 Delivery from a daemon: the outbox needs a channel `from()`; add an internal route the daemon calls with
  the store-held internal secret (reuse `isInternal` from `lib/self.ts`) instead of importing eve channels.
- `[to-do]` V3.3 `vercel.json` `daemons` block, opt-in via a documented switch; when no daemon runs, today's paths
  (console polls, self-POST, tick cron, boot sweep) stay exactly as they are.
- `[to-do]` V3.4 Health: the daemon writes a heartbeat doc; the console's Usage page shows "background worker: running /
  last seen"; the tick logs a warning if the daemon is configured but silent.
- `[to-do]` V3.5 Docs: configuration, README deploy section (production only, Hobby quota).
- **Tests:** unit for the loop's step function with fakes; live: a job scheduled 2 minutes out on production with the
  console closed wakes within 60 s.
- **Done when:** with the daemon on, nothing depends on a console being open; with it off, behaviour is unchanged.

### V4. Vercel Connect as a connector auth kind (F4) `[to-do]` (depends on V0.4)
- `[to-do]` V4.1 `connectors.ts`: auth kind `connect` (`{ connector: 'linear/<name>' }`), stored without secrets.
- `[to-do]` V4.2 `connector-connection.ts`: build the MCP connection with `@vercel/connect/eve`'s `connect()` auth when the
  kind is `connect`; gates, `decideCall`, approvals, reviewed reads unchanged.
- `[to-do]` V4.3 Console `connectors-page.tsx`: "Add from Vercel Connect" lists the team's Connect connectors (via
  `vercel connect` API) on Vercel deployments; hidden locally.
- `[to-do]` V4.4 Per-person grants: map the operator principal to Connect's `subject`; first use opens Connect's consent.
- `[to-do]` V4.5 Docs: connectors doc; local mode keeps our own OAuth.
- **Tests:** unit for the connection shape (`tests/connection-shape.test.ts`) and gates with a `connect` connector;
  live: a Linear read through Connect on a preview, held for approval under gate `all`.

### V5. Event-driven Bots via MCP Events (F5) `[to-do]` (depends on V4)
- `[to-do]` V5.1 Event subscriptions as a new routine kind: "when <event> on <connector>, <brief>", stored with the Bot.
- `[to-do]` V5.2 Ingest: eve's `experimental_events.onEvent` on the connection → verify → `enqueue` into the Bot's room
  (durable, since Connect does not replay) → `flushOutboxSoon`.
- `[to-do]` V5.3 Console: add/remove an event routine in the Bot's panel next to scheduled routines.
- `[to-do]` V5.4 Budget and noise guards: per-routine rate limit, de-dup by event idempotency key, events count against
  the workspace budget like any job.
- **Tests:** unit for ingest (verify, de-dup, enqueue); live on production: an assigned Linear issue starts a job.

### V6. AI Gateway controls (F6) `[in-progress]` (small; independent)
- `[done]` V6.1 One `gatewayOptions()` in `agent/lib/models.ts` for every Gateway call (HQ and teammate model resolvers,
  `generateText` in memory/intro/roster, `embed`, Jev): `zeroDataRetention` from `BOT_ZDR=1`, `inferenceRegion` from
  `BOT_INFERENCE_REGION=us`.
  As built: HQ's static model and the teammate's per-turn selection carry it as eve `modelOptions.providerOptions`;
  direct calls merge it with `withGatewayOptions`. `@ai-sdk/gateway` 4.0.113 types only `zeroDataRetention`, but the
  provider sends options through unvalidated, so `inferenceRegion` reaches Gateway as documented.
- `[done]` V6.2 Recognise HTTP 402 `quota_for_entity_exceeded`: halt the run with the budget reason
  (`BUDGET_HALT_REASON` in `lib/budget.ts`) and a feed line "AI Gateway budget reached", not a raw error.
- `[done]` V6.3 Map 400 `no_providers_available` (ZDR/region with no compliant provider) to a clear message naming the
  model and the setting.
  As built: `explainGatewayError` in `lib/models.ts`. A Gateway budget stop blocks the job with the reason, as our
  own budget stop does, so it waits for a person rather than failing; "no provider" fails it with the setting named.
  The console says both plainly when HQ's own turn fails (`failureNotice` in `room-store.ts`).
- `[to-do]` V6.4 Docs: configuration, `docs/safety.md` (what ZDR/US-only do and cost; Gateway budgets as a backstop set
  in the dashboard).
- **Tests:** unit for options per call site and the two error mappings (`tests/models.test.ts`, `tests/budget.test.ts`).

### V7. Free models and Token Pass (F7) `[to-do]` (small)
- `[to-do]` V7.1 Try `stealth/cat-jam` as `BOT_MEMORY_MODEL` locally with the existing capture eval; keep Nemotron for
  HQ and teammate (user preference). Record pass rate here.
- `[to-do]` V7.2 Docs: free/cheap model options (Nemotron, Cat Jam: free, no ZDR, may disappear; Token Pass).

### V8. Passport sign-in (F8) `[parked]` until someone on Enterprise asks
- `[parked]` V8.1 `access.ts`: verified identity from `@vercel/passport` `getIdentity()` when present, replacing the
  unverified `_vercel_jwt` decode; tokens and local open mode unchanged.

## Order of work
1. V0.1–V0.5 spikes (one day), then V6 (small, independent) in parallel.
2. V1 (image) — biggest reliability win, local and Vercel.
3. V3 (daemons) and V2 (drive), driven by spike results.
4. V4 then V5 (Connect, then events).
5. V7 any time; V8 parked.

## Critical files
`agent/sandbox/sandbox.ts`, `agent/lib/computer-config.ts`, `agent/lib/team-computer.ts`,
`agent/lib/computer/{script,runtime,control}.ts`, `agent/lib/computer-backup.ts`, `agent/lib/hands/kinds.ts`,
`agent/lib/{outbox,self,dispatch,jobs}.ts`, `agent/schedules/tick.ts`, `agent/lib/connectors.ts`,
`agent/lib/connector-connection.ts`, `src/console/connectors-page.tsx`, `agent/lib/{models,budget,spend}.ts`,
`agent/lib/access.ts`, `vercel.json`, `docs/configuration.md`.

Reuse: `machineName()` / machine record (team-computer.ts), `isInternal` + internal secret (self.ts), `enqueue` /
`deliverOutbox` / `sendInto` (outbox, ops.ts), `dispatchDue`, `decideCall` gates, `BUDGET_HALT_REASON`,
`Capabilities` in kinds.ts, the QA harness with `QA_BYPASS`.

## Verification
- Every task: `npm run typecheck`, `npx vitest run`, `BOT_SKIP_SANDBOX_PREWARM=1 npm run build`.
- Live, per track: QA with `QA_JOBS=1` against a scratch preview (V1, V2, V4, V6); a production check for V3 and V5
  (daemons and MCP events do not run on previews); Docker by hand for V1 (fresh machine, browser + shell job).
- Local mode check after every track: `npm run dev` with `BOT_COMPUTER=local`, a job runs, schedules fire, nothing
  needs Vercel.
