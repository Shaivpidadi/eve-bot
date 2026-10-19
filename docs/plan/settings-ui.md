# Plan: every setting from the console

Branch `feat/model-picker` (continues the Models page). Tags: `[to-do]`, `[in-progress]`, `[done]`, `[parked]`.
Conventional Commits, no co-author line, one commit per small task. Full check (typecheck, tests, build, a live run
on free models) after each phase.

## Why

The code reads 126 environment variables, 103 of them its own `BOT_…` settings. Changing any means editing `.env` or
Vercel's project settings and restarting or redeploying. People should set the app from the console. `.env` stays for
what the console itself depends on, and as the defaults.

## Decisions (asked 19 Oct)

- **D1. Owner only for deployment-wide settings.** The owner is whoever holds `BOT_CONSOLE_TOKEN`, signs in through
  Vercel Authentication, or runs the console locally with it open. Tokens from `BOT_CONSOLE_TOKENS` are tenants: they
  change only their own workspace's settings (models, budget, timezone, …) and see the deployment's read-only.
  `BOT_SETTINGS_EDITABLE=off` makes everything read-only, for deployments managed purely by environment variables
  (`BOT_MODELS_EDITABLE` keeps working as its narrower alias).
- **D2. Secrets in the UI, sealed.** Search and email-webhook keys are typed once, sealed with the same key as connector
  secrets, and never sent back: the page shows only whether one is set, with Replace and Remove. An env value still
  works as the fallback.
- **D3. Nothing waits for a restart that doesn't need to.** (Asked: "look at daemons, drive and other Vercel".)
  - **Live:** the background worker (the daemon is always deployed and asks the app each pass whether it is on and how
    often to run); the Vercel computer's network allowlist and timeout (`sandbox.update`).
  - **From the computer's next start:** drive, vCPUs, Chrome flags, proxy, shell ports.
  - **After a restart or deploy**, because they are fixed when the app starts:
    - the image machines are built from;
    - the backend choice (Vercel or local);
    - the computer's name;
    - eve's per-session cost and token caps;
    - cron schedules.

    These still live in the UI. The build and start scripts read the saved values into a generated file the app loads
    at start, so a change applies with the next deploy on Vercel and the next restart locally. The page marks such a
    change as waiting.
- **D4. Precedence:** a value saved in the console, then the environment variable, then the built-in default. The page
  shows each value's source (Default, From .env, Changed) and Reset goes back to the environment's value.
- **D5. Scope:** each setting is deployment-wide (the shared computer, search, data controls) or per workspace
  (models, budgets, timezone, default Bot name, memory floor), as in the inventory below.

## Architecture

- **Registry** `agent/lib/settings/registry.ts`, one entry per setting:
  - key, env name and type (number, boolean, text, list, choice, secret);
  - scope, and when it applies (live, next start, restart);
  - label and help, limits, the built-in default.

  The single source for validation, the API and the page.
- **Store** `agent/lib/settings/store.ts`:
  - `settings/deployment.json` and `settings/workspaces/<id>.json`; secrets sealed;
  - read with a 30 s cache, the store loaded lazily (workflow bundles can't take it; see `run_job`'s fix).
- **Read** `await setting(key, { workspaceId })`, cached. Hot or synchronous readers (module-level constants today)
  become functions; a few hot paths get the cached value pushed when a setting changes.
- **Apply hooks** for settings that act on something running:
  - the computer's update on Vercel;
  - the worker's next interval;
  - the browser's next start.
- **Restart tier** `agent/generated/settings.json`, written by `scripts/build.mjs` (Vercel build) and `scripts/start.mjs`
  / dev from the store, read synchronously at load; env, then default, when absent.
- **API:**
  - `GET /bot/v1/settings`: every setting with its value, source, scope, whether it may be edited here, and any change
    waiting for a restart.
  - `PUT /bot/v1/settings`: a set of changes, validated by the registry, owner-gated per scope.
- **Console:** a Settings sheet with sections (Spend, Models, Team computer, Browser, Web search, Email, Memory &
  decisions, Background work, Team, Data controls). Models keeps its picker as a section. Fields are rendered from the
  registry.

## Phases

### S1. Framework `[done]`
- The registry, store, reader, owner flag in `access.ts`, API routes, and sealing shared with connectors.
- **Tests:** precedence, validation, sealing, owner gating, the lock.

### S2. Settings page `[done]`
- A generic sheet rendered from the registry: source badges, Reset, secret fields, "applies after restart" marks, the
  read-only view for tenants and locked deployments. The Models page becomes its Models section.

### S3. Live settings, area by area `[to-do]` (one commit per area, tests each)
- **Spend:** budgets (workspace), computer rates, model prices. The budget message stops saying "raise
  BOT_BUDGET_MONTHLY_USD" and points to Settings.
- **Browser:** allowed domains, page size, settle, guard, output, pilot.
- **Team computer (runtime):** idle minutes, screens, control minutes, token TTL, backups, shell isolation.
- **Web search** (sealed key). **Email webhook** (sealed token).
- **Memory & decisions:** Jev on/model/confidence, memory floor, embeddings. **Models:** reasoning levels.
- **Data controls:** ZDR, region, export, update check. **Team:** timezone, default Bot name, standup room, activity
  retention, tick batch.
- **Background work:** the daemon asks the app; off, it checks every 10 minutes.

### S4. Next-start computer settings `[to-do]`
- Drive, vCPUs, timeout, network allowlist, Chrome flags, proxy, apt mirror, shell ports.
- On Vercel, a change is pushed to the running machine with `sandbox.update` where Vercel allows it (allowlist,
  timeout live; vCPUs and mounts from the next session). On Docker it applies at the container's next start.

### S5. Restart tier `[to-do]`
- The generated settings file at build and start: image, backend, computer name, local port/bind/forwarder, cost and
  token caps, cron schedules.
- The page lists changes waiting for a restart or deploy.

### S6. Docs `[to-do]`
- `docs/configuration.md` turns around: "Set everything in Settings; these are the environment variables the app needs
  before it can show Settings (and the defaults)". `.env.example` keeps only the env-only ones plus a pointer.


## Review (19 Oct), and what changed

An independent pass against the code found eight problems; the plan above is amended as follows. Where this section
and the earlier text disagree, this section wins.

- **R1. "After restart" is "after rebuild".** `eve build` fixes these in `.eve/compile/compiled-agent-manifest.json`:
  - cost caps and reasoning;
  - cron schedules;
  - tool definitions and their approvals;
  - the sandbox backend.

  `npm start` rebuilds only when `.output/` is missing or `BOT_BUILD_ON_START=1`.

  So the rebuild tier works by **overlaying saved values into `process.env` before a build**: in `scripts/build.mjs`
  (Vercel) before `eve build`/`next build`, and in `scripts/start.mjs`, which rebuilds when a rebuild-tier value
  changed. There is no runtime JSON file.

  The build records the values it used, keyed by deployment id, so the page can say which changes wait for the next
  deploy. The job's budget estimate uses the built value, not the saved one. A failed store read at build falls back
  to env and never fails the build.
- **R2. Owner, precisely:**
  - **Tokens:** owner comes from the token that matched (`BOT_CONSOLE_TOKEN`), not the workspace. A
    `BOT_CONSOLE_TOKENS` entry naming `default` is still a tenant.
  - **Open mode:** owner only under the development default (not on Vercel, not production). Under an explicit
    `BOT_CONSOLE_OPEN=1`, deployment settings are read-only.
  - **Vercel Authentication:** owner only on the production deployment (`VERCEL_ENV=production`). Previews share the
    store, so there they read but don't write deployment settings.
  - **Tenants:** see only what affects them, never deployment values such as webhook URLs. Their budget may only go
    *below* the deployment's ceiling.
  - **No owner** (tokens only, no `BOT_CONSOLE_TOKEN`): the page says how to become one.
- **R3. Sealing and export:**
  - **Where it's stored:** workspace settings at `settings/<ws>/settings.json` (next to `operator.json`), deployment
    settings at `settings/_deployment.json` (no workspace id can match a leading underscore).
  - **Sealing:** secrets use a distinct derivation label (`bot-settings:`). A value that can no longer be unsealed
    reads as "not set, enter it again".
  - **Export:** settings docs count as secret in exports, and `secrets=1` exports become owner-only.
- **R4. Readers:**
  - **One place for precedence:** `await effectiveEnv(workspaceId?)` returns `{ ...process.env, ...decoded settings }`.
    The existing pure `(env)` functions stay and callers pass it in, so precedence lives in one place and the 44 test
    files that stub env keep working.
  - **Module constants** become functions of env. Process caches (`runtime ??=`, `configured ??=`) are keyed by the
    settings version.
  - **The workflow body** (`run_job`'s `"use workflow"`) never reads settings: the ZDR and region flags for its error
    text are captured in a step.
  - **The computer's template `prepare`** reads env only.
- **R5. Live apply on Vercel:** a `TeamComputer` `onMachine` reconcile is always installed, not only with a drive. It
  pushes allowlist, timeout and vCPUs with `sandbox.update` and is cached per machine and settings version, so a
  replacement machine made with the build's values is corrected on first use. On Docker these apply when the container
  is recreated, and the page says so.
- **R6. The worker:** `BOT_WORKER` (env) stays the hard gate. Off means no calls and no store reads, as now. The UI
  can only pause it or set the interval while env has it on. The tick answers with the decision before any other store
  read, and the settings are read once per pass.
- **R7. Smaller:**
  - **Models:** keep `models/<ws>.json`; the registry delegates to it (one source).
  - **On the page:** say "applies within about 30 seconds"; show "overrides the env value" when both are set.
  - **Copy and scripts:** update console copy that names env vars; leave the scripts (`setup.mjs`, `reset.mjs`,
    `jev-report.mjs`) on env.
  - **Tests and conditions:** a global `forgetSettings()` for tests, and an "applies when" condition per setting to
    hide what doesn't apply here (local-only knobs on Vercel, endpoint-only knobs on Gateway).
- **Reclassified to `.env` only:**
  - shell isolation (a security fence fixed at build);
  - web search (only on a custom endpoint, which is env-only; the tool is chosen at build);
  - the computer's name (it derives the sealing key and names the drive, backups and machine);
  - the two cron schedules (a bad value can break the next deploy).
- **Reasoning** is live on AI Gateway only (returned with the model selection); fixed at build on a custom endpoint.

## Inventory (all 103 `BOT_…` settings the code reads, 19 Oct 2026)

| | Count |
| --- | --- |
| UI, live | 46 |
| UI, from the computer's or browser's next start | 9 |
| UI, after rebuild (deploy on Vercel, `npm start` rebuild locally) | 12 |
| `.env` only (bootstrap, sign-in, build, debug, custom endpoint, security fences) | 36 |

| Setting | Area | Scope | Where | Note |
| --- | --- | --- | --- | --- |
| `BOT_BUDGET_MONTHLY_USD` | Spend | workspace | UI, live | monthly cap |
| `BOT_BUDGET_DAILY_USD` | Spend | workspace | UI, live | daily cap |
| `BOT_HQ_COST_LIMIT_USD` | Spend | deployment (owner) | UI, after restart | eve's per-session cap, fixed at start (later: enforce in our hooks) |
| `BOT_JOB_COST_LIMIT_USD` | Spend | deployment (owner) | UI, after restart | as above, per job; the job estimate reads it live |
| `BOT_HQ_INPUT_TOKEN_LIMIT` | Spend | deployment (owner) | UI, after restart | token caps for unpriced endpoints, fixed at start |
| `BOT_HQ_OUTPUT_TOKEN_LIMIT` | Spend | deployment (owner) | UI, after restart |  |
| `BOT_JOB_INPUT_TOKEN_LIMIT` | Spend | deployment (owner) | UI, after restart |  |
| `BOT_JOB_OUTPUT_TOKEN_LIMIT` | Spend | deployment (owner) | UI, after restart |  |
| `BOT_COMPUTER_USD_PER_HOUR` | Spend | deployment (owner) | UI, live | computer rate |
| `BOT_COMPUTER_USD_PER_CPU_HOUR` | Spend | deployment (owner) | UI, live |  |
| `BOT_COMPUTER_USD_PER_GB_HOUR` | Spend | deployment (owner) | UI, live |  |
| `BOT_MODEL_PRICES` | Spend | deployment (owner) | UI, live | prices off Gateway |
| `BOT_HQ_MODEL` | Models | workspace | UI, live | already on the Models page |
| `BOT_TEAMMATE_MODEL` | Models | workspace | UI, live | already on the Models page |
| `BOT_MODEL_QUICK` | Models | workspace | UI, live | already on the Models page |
| `BOT_MODEL_STANDARD` | Models | workspace | UI, live | already on the Models page |
| `BOT_MODEL_DEEP` | Models | workspace | UI, live | already on the Models page |
| `BOT_MEMORY_MODEL` | Models | workspace | UI, live | already on the Models page |
| `BOT_HQ_REASONING` | Models | workspace | UI, live | on AI Gateway, returned with the model selection; fixed at build on a custom endpoint |
| `BOT_TEAMMATE_REASONING` | Models | workspace | UI, live | on AI Gateway, returned with the model selection; fixed at build on a custom endpoint |
| `BOT_MODELS_EDITABLE` | Models | deployment (owner) | .env only | replaced by owner-only editing + BOT_SETTINGS_EDITABLE |
| `BOT_ZDR` | Data controls | deployment (owner) | UI, live |  |
| `BOT_INFERENCE_REGION` | Data controls | deployment (owner) | UI, live |  |
| `BOT_JEV` | Memory & decisions | deployment (owner) | UI, live |  |
| `BOT_JEV_MODEL` | Memory & decisions | deployment (owner) | UI, live |  |
| `BOT_JEV_CONFIDENCE` | Memory & decisions | deployment (owner) | UI, live |  |
| `BOT_JEV_DEBUG` | Memory & decisions | deployment (owner) | .env only | developer logging |
| `BOT_MEMORY_FLOOR` | Memory & decisions | workspace | UI, live |  |
| `BOT_MEMORY_EMBEDDINGS` | Memory & decisions | deployment (owner) | UI, live |  |
| `BOT_MEMORY_EMBEDDING_MODEL` | Memory & decisions | deployment (owner) | UI, live |  |
| `BOT_MODEL_BASE_URL` | Models | deployment (owner) | .env only | custom endpoint shapes the agent definitions |
| `BOT_MODEL` | Models | deployment (owner) | .env only | custom endpoint |
| `BOT_MODEL_API_KEY` | Models | deployment (owner) | .env only | custom endpoint (goes with the URL) |
| `BOT_MODEL_CONTEXT_TOKENS` | Models | deployment (owner) | .env only | custom endpoint |
| `BOT_SEARCH_PROVIDER` | Web search | deployment (owner) | .env only | only matters on a custom endpoint, which is env-only; the tool is chosen at build |
| `BOT_SEARCH_URL` | Web search | deployment (owner) | .env only | as above |
| `BOT_SEARCH_API_KEY` | Web search | deployment (owner) | .env only | as above |
| `BOT_EMAIL_WEBHOOK` | Email | deployment (owner) | UI, live |  |
| `BOT_EMAIL_WEBHOOK_TOKEN` | Email | deployment (owner) | UI, live | secret, sealed |
| `BOT_EMAIL_WEBHOOK_TIMEOUT_MS` | Email | deployment (owner) | UI, live |  |
| `BOT_COMPUTER_IDLE_MINUTES` | Team computer | deployment (owner) | UI, live |  |
| `BOT_COMPUTER_MAX_SCREENS` | Team computer | deployment (owner) | UI, live |  |
| `BOT_COMPUTER_CONTROL_MINUTES` | Team computer | deployment (owner) | UI, live |  |
| `BOT_COMPUTER_TOKEN_TTL_SECONDS` | Team computer | deployment (owner) | UI, live |  |
| `BOT_BACKUP_EVERY_MINUTES` | Team computer | deployment (owner) | UI, live |  |
| `BOT_BACKUP_MAX_MB` | Team computer | deployment (owner) | UI, live |  |
| `BOT_COMPUTER_DRIVE` | Team computer | deployment (owner) | UI, next start | Vercel: mounts from the machine's next start |
| `BOT_COMPUTER_DRIVE_GB` | Team computer | deployment (owner) | UI, next start |  |
| `BOT_SANDBOX_VCPUS` | Team computer | deployment (owner) | UI, next start | Vercel: sandbox.update, next session; Docker: next start |
| `BOT_SANDBOX_TIMEOUT_MINUTES` | Team computer | deployment (owner) | UI, next start | Vercel: sandbox.update, live |
| `BOT_SANDBOX_ALLOW_DOMAINS` | Team computer | deployment (owner) | UI, next start | Vercel: sandbox.update network policy, live; Docker: next start |
| `BOT_COMPUTER_CHROME_FLAGS` | Team computer | deployment (owner) | UI, next start | next browser start |
| `BOT_COMPUTER_APT_MIRROR` | Team computer | deployment (owner) | UI, next start | next install |
| `BOT_BROWSER_PROXY` | Team computer | deployment (owner) | UI, next start | next browser start |
| `BOT_SHELL_TCP_PORTS` | Team computer | deployment (owner) | UI, next start | next shell fence setup |
| `BOT_SHELL_ISOLATION` | Team computer | deployment (owner) | .env only | a security fence, fixed in the tool definitions at build |
| `BOT_COMPUTER_IMAGE` | Team computer | deployment (owner) | UI, after restart | machines are built from it at start |
| `BOT_COMPUTER` | Team computer | deployment (owner) | UI, after restart | backend choice |
| `BOT_COMPUTER_LOCAL` | Team computer | deployment (owner) | UI, after restart |  |
| `BOT_COMPUTER_NAME` | Team computer | deployment (owner) | .env only | renaming would orphan the sealing key, drive, backups and machine |
| `BOT_COMPUTER_LOCAL_PORT` | Team computer | deployment (owner) | UI, after restart |  |
| `BOT_COMPUTER_LOCAL_BIND` | Team computer | deployment (owner) | UI, after restart |  |
| `BOT_COMPUTER_FORWARDER_IMAGE` | Team computer | deployment (owner) | UI, after restart |  |
| `BOT_COMPUTER_KEY` | Team computer | deployment (owner) | .env only | secret the computer's tokens are signed with |
| `BOT_SANDBOX_PREINSTALL_BROWSER` | Team computer | deployment (owner) | .env only | build-time |
| `BOT_SANDBOX_REVISION` | Team computer | deployment (owner) | .env only | build-time |
| `BOT_BROWSER_ALLOWED_DOMAINS` | Browser | deployment (owner) | UI, live |  |
| `BOT_BROWSER_PAGE_CHARS` | Browser | deployment (owner) | UI, live |  |
| `BOT_BROWSER_SETTLE_MS` | Browser | deployment (owner) | UI, live |  |
| `BOT_BROWSER_GUARD_MS` | Browser | deployment (owner) | UI, live |  |
| `BOT_BROWSER_MAX_OUTPUT` | Browser | deployment (owner) | UI, live |  |
| `BOT_PILOT_SECONDS` | Browser | deployment (owner) | UI, live |  |
| `BOT_WORKER` | Background work | deployment (owner) | UI, live | daemon asks the app each pass |
| `BOT_WORKER_EVERY_SECONDS` | Background work | deployment (owner) | UI, live |  |
| `BOT_WORKER_VERBOSE` | Background work | deployment (owner) | .env only | developer logging |
| `BOT_TICK_CRON` | Background work | deployment (owner) | .env only | a bad value can break the next deploy (Hobby allows daily only) |
| `BOT_TICK_BATCH` | Background work | deployment (owner) | UI, live |  |
| `BOT_TICK_ON_START` | Background work | deployment (owner) | .env only | startup script |
| `BOT_STANDUP_CRON` | Team | deployment (owner) | .env only | as above |
| `BOT_STANDUP_ROOM` | Team | deployment (owner) | UI, live |  |
| `BOT_TIMEZONE` | Team | workspace | UI, live |  |
| `BOT_DEFAULT_BOT_NAME` | Team | workspace | UI, live |  |
| `BOT_ACTIVITY_RETAIN` | Team | deployment (owner) | UI, live |  |
| `BOT_EXPORT` | Data controls | deployment (owner) | UI, live |  |
| `BOT_UPDATE_CHECK` | Data controls | deployment (owner) | UI, live |  |
| `BOT_STORE` | Bootstrap | deployment (owner) | .env only | where settings themselves are stored |
| `BOT_STORE_PREFIX` | Bootstrap | deployment (owner) | .env only |  |
| `BOT_DATA_DIR` | Bootstrap | deployment (owner) | .env only |  |
| `BOT_CONSOLE_TOKEN` | Bootstrap | deployment (owner) | .env only | who may open the console |
| `BOT_CONSOLE_TOKENS` | Bootstrap | deployment (owner) | .env only |  |
| `BOT_CONSOLE_AUTH` | Bootstrap | deployment (owner) | .env only |  |
| `BOT_CONSOLE_OPEN` | Bootstrap | deployment (owner) | .env only |  |
| `BOT_DEFAULT_WORKSPACE` | Bootstrap | deployment (owner) | .env only |  |
| `BOT_WORKSPACE` | Bootstrap | deployment (owner) | .env only | scripts only |
| `BOT_PUBLIC_URL` | Bootstrap | deployment (owner) | .env only | OAuth redirect address |
| `BOT_DEV_ORIGINS` | Bootstrap | deployment (owner) | .env only | next.config, dev only |
| `BOT_WORKFLOW_WORLD` | Bootstrap | deployment (owner) | .env only | the agent definition |
| `BOT_QA` | Bootstrap | deployment (owner) | .env only | test faults |
| `BOT_BUILD_ID` | Bootstrap | deployment (owner) | .env only | build |
| `BOT_VERSION` | Bootstrap | deployment (owner) | .env only | build |
| `BOT_BUILD_ON_START` | Bootstrap | deployment (owner) | .env only | startup script |
| `BOT_PREWARM_ON_START` | Bootstrap | deployment (owner) | .env only | startup script |
| `BOT_SKIP_SANDBOX_PREWARM` | Bootstrap | deployment (owner) | .env only | build script |
