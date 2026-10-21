# Bots on Claude Code or Codex: a plan

Written Oct 20, 2026 against eve-bot `main` at `175d976` (0.6.2) and `durable-harness` 0.0.1-beta.6 (repo `vercel-labs/durable-harness` at `fb056a3`).

**Revised Oct 20, evening.** Shaishav gave the go to build this on local branches only: no push, no PR, nothing merged to main. This version folds in the six changes from the review of his local Claude Code session. Each is marked **(review)** where it lands. The review also found a shell-fence escape on `main` (`heal()` in the Bot shell helper). That is fixed first, on its own branch, and the harness work builds on top of it.

Things I could not confirm are marked **(unverified)**.

## 1. What changed in eve-bot since 0.4.0

0.4.0 (`55e27d5`) went to production Oct 16. Since then, 7 PRs merged and 6 releases were tagged (0.5.0 to 0.6.2). That's 107 files changed, all of it between Oct 19 and Oct 20.

- **#19 Models and settings from the console (0.5.0).** Settings → Models lists AI Gateway models, free ones first, and lets you pick one per role (`hq`, `standard`, `quick`, `deep`, `helper`). One switch puts everything on free models. Most `.env` settings now live on a Settings page, with tabs for Spend, Team computer, Browser, Memory, Email, Background work, Team and Data controls. The owner and tenants are told apart, and secrets are sealed. Files: `agent/lib/model-settings.ts`, `agent/lib/gateway-models.ts`, `agent/lib/settings/registry.ts`, `agent/lib/settings/store.ts`, `src/console/models-page.tsx`, `src/console/settings-page.tsx`.
- **#20 Copies update themselves again (0.5.1).** Deploy-button copies check once a day and take a tagged release once it's six hours old. The sync no longer touches workflow files. "Update now" really updates, given a GitHub token sealed in Settings. File: `agent/lib/updater.ts`.
- **#21 Sync commits authored as the owner (0.5.2).** Vercel had blocked deploys of sync commits on private copies.
- **0.5.3 and 0.5.4 (direct commits).** The sidebar button fix, a retryable "Update now", and the console now learns of a release within half an hour.
- **#22 Installable app and push notifications (0.6.0).** The console installs as a PWA. "Needs you" pushes (approvals, questions, sign-offs) go out at once. "Done" pushes wait out quiet hours. A `notify` tool lets Bots send their own news, with per-person settings. Files: `agent/lib/notify.ts`, `agent/lib/push.ts`, `agent/lib/push-prefs.ts`, `agent/lib/notify-tool.ts`, `src/console/notifications-section.tsx`.
- **#23 Background worker off by default.** `vercel.json` no longer declares the Daemon, which had billed an idle 2 GiB instance around the clock on Pro. The worker is now opt-in (`docs/configuration.md`).
- **#24 Signed-in home goes to the console (0.6.1).** A marker cookie sends a signed-in person from `/` to `/bot`.
- **#25 CI only in the original repo (0.6.2).** Private copies no longer burn their own Actions minutes on CI and the image build.

There is still no code that lets a Bot run on anything except eve.

## 2. The problem

Every Bot runs on eve today. The `teammate` subagent does the work on the one shared team computer, which has Chrome, the shell and the files. That's right for browser and inbox work. For coding work, Claude Code and Codex have the loops people already trust: their prompts, their file editing and their way of handling a repo. Someone might hire a "Coder" Bot and want it to be Claude Code, or compare Codex with Claude Code on the same job.

Until this week, running those CLIs in the cloud meant a VM with no crash recovery. `durable-harness` changes that. Each session is a Workflow run with a durable log. A crashed turn resumes on a new function. Finished model and tool calls are never re-run or re-billed. Tools declare `replay: 'safe'` or `'never'`.

The question is whether, and how, an eve-bot Bot can choose its engine (`eve`, `claude-code` or `codex`) without losing what makes eve-bot safe: approval gates, the run fence, budgets and connectors.

## 3. What durable-harness actually gives us

From the blog post (Oct 19), the Vercel docs pages for Claude Code and Codex, and the package source:

- **Packages.** One npm package, `durable-harness`, with entry points such as `durable-harness/claude-code`, `/codex` and `/sandbox`. It is Apache-2.0 and still on `0.0.x`. The README says the API may change between releases. The Claude Code and Codex adapters are marked experimental in the docs. The package first appeared on npm Oct 15, 2026.
- **Pinned versions.** Claude Code needs `@anthropic-ai/claude-agent-sdk@0.3.296` exactly, with CLI 2.1.296 in the VM. Any other version fails the turn. Codex is pinned to 0.160.0, which comes with the Sandbox. Both pins move only with a `durable-harness` release.
- **Where things run.** The CLI runs only in a per-session Vercel Sandbox, with `/workspace` on a per-session Drive that outlives the VM. The Function drives the session, runs our tools, writes the log and makes the model calls. The docs say the Sandbox holds no secrets.
- **Models and keys.** Model calls go from the VM through a fixed route table (`CLAUDE_ROUTES`: Anthropic `/v1/messages`; `CODEX_ROUTES`: OpenAI `/v1/responses`) to AI Gateway. The credential is added in the Function: `AI_GATEWAY_API_KEY`, else the Vercel OIDC token. Neither adapter needs an Anthropic or OpenAI key. Codex works with any Gateway model that supports the Responses API.
- **Subscriptions.** I found no code path that uses a Claude Pro/Max or ChatGPT subscription. Billing is Gateway credits. Whether any of that is allowed under those subscriptions' terms doesn't come up, because the package doesn't do it **(unverified beyond grepping the source and docs)**.
- **Tools.** Tool-less by default: the model gets only our `HostTool`s, which run in the Function as MCP (Claude Code) or app-server dynamic tools (Codex). Each tool has `replay: 'safe' | 'never'`. A `'never'` call runs at most once, and after a crash the model is told it "may have taken effect". `HostToolIO` gives the tool `ctx.runId` (the session's run id), `docs`, and a `park` hook for work another party settles. Park looks usable for approvals, but nothing documents it for that **(unverified)**.
- **Built-ins.** `builtins: true` turns on Claude Code's Bash, Read, Edit, Write, NotebookEdit and WebFetch, or Codex's shell and `apply_patch`. They run in the VM on `/workspace`. Each call is logged before it runs and is never re-run. Claude Code's Bash runs under bubblewrap inside the VM, and the turn fails if bubblewrap can't start. Subagents (`Task`), background shells and cron tools stay off.
- **Network.** The Sandbox defaults to `allow-all`. `network: 'deny-all'` or `{ allow: [...] }` restricts it, and the CLI still works because model calls go through the Function.
- **Budget.** `sandbox({ budget: { turnUsd, sessionUsd, vmSeconds } })`. The default is 4 hours of VM time per session and no spend cap. Spend is counted in the session's log.
- **World.** Vercel World on Vercel, `.workflow-data` locally. Postgres, MongoDB, Redis or Turso when self-hosted (`WORKFLOW_TARGET_WORLD`). Even self-hosted, Claude Code and Codex still need a Vercel Sandbox, which takes a Vercel token, team and project.
- **Documents.** `defineDoc` gives typed JSON in the session log, edited through `io.docs` and readable with `agent.sessions.doc()`.
- **Routes.** `agent.chatRoute({ authorize })` streams over SSE. In production it returns 401 for every request unless `authorize` is set. A queue route (`flowHandler`) drives turns. On Next.js, `withDurableHarness(nextConfig)` writes it. If the app also uses the Workflow SDK, the route moves to `/.well-known/durable-harness/v1/flow` and needs a `vercel.json` entry.
- **Known limits.** The chat route drives a turn for the first 60 seconds before the queue takes over, and a command still running at that handover is stopped. The workaround is `drive: 'queue'`. A session can't run past the plan's maximum session length, so the Sandbox is replaced between turns. Every session starts a Sandbox, even with no tools.
- **Traces.** Sessions show up in Vercel's Agent Runs tab.
- **Same model per agent.** `claudeCode({ name, model })` is defined at module load. Two agents of one harness need stable, distinct names. Choosing a model per session is not shown in the docs **(unverified)**.

## 4. How it maps onto eve-bot today

### 4.1 Where the engine choice lives

- **The Bot record.** Add `engine?: "eve" | "claude-code" | "codex"` to `Bot` in `agent/lib/types.ts`. A missing value means `eve`, so every existing Bot is unchanged. It's set in `hireBot` and `patchBot` (`agent/lib/bots.ts`) and in the tools HQ uses (`agent/tools/hire_bot.ts`, `agent/tools/update_bot.ts`).
- **The deployment switch.** A setting in the registry (`agent/lib/settings/registry.ts`), for example `BOT_ENGINES=off|claude-code|codex|both`, owner-only and off by default. Tenants can't turn it on.
- **HQ stays on eve.** Only Bots doing jobs get an engine. HQ is the router, and it needs eve's approval cards, connectors and memory.

### 4.2 How a run dispatches

- `routeWork` (`agent/lib/routing.ts`) still picks the Bot. Nothing changes there.
- The seam is a single call in `agent/tools/run_job.ts` (around line 250): `ctx.agent("teammate").send(claim.brief, { signal })`. For a Bot with `engine !== "eve"`, a `"use step"` function would instead:
  1. call `agent.sessions.start()` on the matching `durable-harness` agent;
  2. save the session id on the job lease's `session` (`JobLease.session` in `types.ts`), so the run fence knows which session owns the job;
  3. `send` the same brief that `renderBrief` (`agent/lib/brief.ts`) already builds.
- The heartbeat loop already in `run_job.ts` looks at the job every 20 seconds and renews the lease only every 24th look (`RENEW_EVERY`, about 8 minutes), not on every look **(review)**. It would also check `sessions.inspect(id)` for the turn ending. It keeps holding no compute in between.
- The result still comes from `finish_job`, as a HostTool (4.3). The existing salvage path ("recovered" completion) covers a session that ends without calling it.
- **Cancel.** `cancel_job` aborts the eve child today. For a harness session the abort maps to `sessions.close(id)`. Whether that stops a turn mid-flight is **(unverified)**, and H0 has to answer it with a plain pass or fail **(review)**. Until it passes, cancel also destroys the session's Sandbox and Drive (`deleteSessionSandbox(id, { force: true })`), which stops whatever the VM was doing. The fence (4.3) is the last backstop: a cancelled run's tools refuse.
- **Watchdog.** `agent/lib/dispatch.ts` and `schedules/tick.ts` need no change. They dispatch by job, not by engine.

### 4.3 Tools, connectors and approval gates

This is the hard part. In eve, gates are eve features: `approval: always()` on `send_email`, `retire_bot` and `request_takeover`, `page_confirm`'s proposal binding (`agent/subagents/teammate/lib/gate.ts`), and the connector gate (`agent/lib/connector-connection.ts`, which returns `"user-approval"` per call). A HostTool has no eve approval card. So:

- **Expose a small, fixed set of eve-bot tools as HostTools,** each with an honest replay policy:

  | eve-bot tool | HostTool replay | Notes |
  | --- | --- | --- |
  | `job_brief`, `log_progress`, `learn` | `safe` | Writes under the run fence (`agent/lib/run-guard.ts`), keyed so a repeat is a no-op |
  | `save_artifact` | `safe` | Content-addressed key, so a repeat overwrites the same thing |
  | `finish_job` | `never` | Its record already carries `producedBy` |
  | `notify` | `never` | Same news twice is what #22 tried to stop |
  | `send_email` | `never` | Only after approval (below) |
  | connector reads | `safe` | Only tools whose policy says `read` (`agent/lib/catalog.ts`) |
  | connector writes | `never` | Only after approval (below) |

- **The fence.** Every HostTool looks up the job by `io.ctx.runId`, the session id from 4.2. Then it calls `guardSideEffect` or `checkRun` exactly as the teammate tools do. A run that lost its lease or was cancelled gets refused.
- **Approvals without eve's card.** A gated HostTool doesn't act on the first call. It writes a proposal through the actions ledger (`proposeAction` in `agent/lib/actions.ts`, keyed by job, run and payload hash, just like `send_email`). It records `input.requested`, which already sends a "Needs you" push (`agent/lib/notify.ts`), puts the job in `blocked`, and returns "waiting for a person".
- **eve-bot runs the approved action itself (review).** When a person approves, eve-bot runs the action once, through the ledger (`applyAction`), after checking the run fence. Then it sends the session a follow-up that says what happened. The model never calls the tool a second time to make it happen, so a model that forgets, or a replay, can't send twice or skip the send.
- **What H2 has to build (review).** Today `noteApproval` is only called inside eve's own approval response (`send_email.ts:75`). There is no console route and no card for approving a ledger proposal. H2 needs both, plus the step that runs the approved action. The earlier 2 to 3 day guess for H2 is low.
- A `park`-based wait could replace the follow-up message later, if it's confirmed to work that way **(unverified)**.
- **No browser in phase 1.** The `page_*` tools are built on eve's `ToolContext` and the shared team computer's Chrome. Moving them across is a project of its own. A Claude Code or Codex Bot is a code-and-files Bot, plus connectors.
- **Built-ins bypass our gates.** That's the biggest risk (section 5). Phase 1 starts with no built-ins: the model gets only eve-bot's HostTools, and the Sandbox's network is `deny-all` **(review)**. Turning on Read, Edit, Write and Bash is decision 3.
- **A no-network Coder Bot can't do much coding (review).** With `deny-all`, Bash can't `git clone` or `npm install`. So once built-ins are on, the owner's allow list becomes the real security setting. Every allowed host is also a way out for data if a page or file prompt-injects the model. `WebFetch` stays off either way.

### 4.4 Sandbox and Drive

- A harness Bot does **not** use the team computer. It gets its own Sandbox and Drive per session. That's a different model from "one shared computer" (`agent/lib/computer.ts`, `agent/lib/team-computer.ts`), and the console has to say so.
- **No sharing with the team Drive.** The team Drive (`agent/lib/computer-drive.ts`, `BOT_COMPUTER_DRIVE`) is mounted read-write by one machine at a time, so a harness VM can't mount it while the team computer holds it. Files go between them as job artifacts (`agent/lib/artifacts.ts`) or a connector such as GitHub. `sandbox()` takes no option for extra mounts **(unverified)**.
- **Cleanup.** Call `deleteSessionSandbox` when a job closes. A daily `sandboxCleanup({ idleDays })` can run from the existing tick (`schedules/tick.ts`).
- The prebuilt computer image from #18 doesn't help here. `durable-harness` builds its own image once per project, or ahead of time with `npx durable-harness sandbox prepare`.

### 4.5 Gateway, budget and billing

- **Keys.** No new model keys. The same `AI_GATEWAY_API_KEY` or OIDC token eve-bot already uses. Nothing new goes in `.env` for models. Self-hosted harness Bots would need `VERCEL_TOKEN`, `VERCEL_TEAM_ID` and `VERCEL_PROJECT_ID` for the Sandbox. Shaishav drops those into `.env` himself, and they stay on his machine.
- **Admission.** `admitRun` (`agent/lib/budget.ts`) reserves before the session starts, the same as now.
- **Hard caps.** Set `sandbox({ budget: { turnUsd, sessionUsd, vmSeconds } })` from the job's limit (`BOT_JOB_COST_LIMIT_USD`, default 5). The library's default has no spend cap.
- **Spend reporting is a gap.** eve-bot's `usage` hook counts each eve step. The harness counts spend in its own log (`hw.spend`). Whether eve-bot can read that per step, or only once the session ends, is **(unverified)**. Until it's checked, the session cap is the real limit, and the workspace's monthly cap is settled at the end.
- **The budget gets weaker (review).** An eve Bot is checked on every step. A harness Bot is checked only at job start (`admitRun`), against its own session cap, and when the month is settled. So five harness jobs running at once can overshoot by five times `BOT_JOB_COST_LIMIT_USD` (default $5) before anything notices. If H0 shows spend can be read mid-run, the 20-second heartbeat checks it and stops the run. If not, eve-bot caps how many harness jobs run at once.
- **Sandbox time is billed on top.** It goes into `computer-spend.ts` as its own line, not mixed with the team computer.
- **Gateway data controls likely don't carry over.** `BOT_ZDR` and `BOT_INFERENCE_REGION` travel as `providerOptions` (`agent/lib/models.ts`, `gatewayOptions`). The harness's gateway handler allowlists the keys a request body may have, and I saw no way to add Gateway provider options. So assume ZDR and region do **not** apply to harness Bots **(unverified)**. With `BOT_ZDR=1`, the engine choice should be refused.
- **No free path on standalone.** A custom endpoint (`BOT_MODEL_BASE_URL`) doesn't fit: the routes speak Anthropic Messages and OpenAI Responses through Gateway. "Standalone on your own models is free" stays eve-only.

### 4.6 HQ routing and the console

- Routing is unchanged. Jev's fit judge could mention the engine in each Bot's criteria line ("runs on Claude Code"), so coding work drifts to the coder Bot.
- **Hire dialog and Bot panel** (`src/console/hire-dialog.tsx`, `src/console/panel.tsx`): an "Engine" choice, shown only when the owner turned engines on. It has a short note: own machine, no browser, billed per session.
- **Models page** (`src/console/models-page.tsx`): a harness Bot's model is fixed per engine, chosen from Gateway models that fit (`anthropic/*` for Claude Code, Responses-capable ones for Codex). Since one agent definition holds one model, the first version offers one model per engine, with a stable `name` each.
- **The thread.** eve-bot's console reads eve's stream today. For a harness Bot, server code reads `sessions.liveEntries` and turns them into the same transcript items (`src/console/transcript.tsx`). The library's `chatRoute` is not exposed to browsers. Everything goes through the console's own gate (`/bot/v1`), so no new public route bills Gateway.
- **Agent Runs.** Each harness session also shows in Vercel's Agent Runs tab. A "View trace" link costs nothing.

### 4.7 Memory

- In eve, memory comes in as messages, and `memoryCaptureHook("job")` learns from the transcript after each turn (`agent/subagents/teammate/hooks/memory.ts`).
- For a harness Bot, recalled memory goes into the brief or `instructions`. When the session ends, the normalized transcript from the log is fed to the same capture code (`agent/lib/memory/capture.ts`). The journal (`agent/lib/journal.ts`) still gets `log_progress` lines through the HostTool, so rewind and resume keep working at the job level.

### 4.8 Where the harness runs in the app

- eve-bot builds with `withEve(nextConfig)` (`next.config.ts`), and the agent is a separate eve service on Vercel. `durable-harness` wants `withDurableHarness(nextConfig)` and a queue route.
- Whether the two wrappers sit together, and whether the queue route lands next to eve's routes cleanly, is **(unverified)**. This is the first thing a spike has to prove.
- **Dependencies (review).** `durable-harness` lists 20 peer dependencies, all marked optional. Several are pinned pre-releases: `effect@4.0.0-rc.112`, `@opencode/core`, `/client`, `/schema` and `/server` at `2.0.22`, and `@vercel/agent-runs@0.0.1`. Claude Code also needs `@anthropic-ai/claude-agent-sdk@0.3.296` exactly. The spike installs them on an eve-bot branch, not a throwaway app, and checks that the build passes, how big the functions get, and that `npm ls` is clean next to `withEve`.
- Both use Workflow worlds. On Vercel each uses the Vercel World. Locally they keep separate data folders (`.eve/.workflow-data` and `.workflow-data`).

## 5. Gaps and risks

1. **Built-in tools bypass approval gates.** Claude Code's Bash and WebFetch, or Codex's shell, can reach the internet with `allow-all` and change files without asking. The mitigations are no built-ins to start, `deny-all` network, no WebFetch, and outside actions only through gated HostTools. With built-ins on, a Bot can still do anything it wants inside its own VM. That's acceptable only because the VM holds no secrets. The allow list then decides what can leave the VM **(review)**.
2. **Cost per job.** Every harness session starts a Sandbox, even for a two-line answer, and keeps it up 5 minutes after each turn (`idleMs`). An eve Bot reuses the one team computer. Set `idleMs` low, close sessions when the job ends, and clean up Drives.
3. **Hobby.** Hobby gets 5 Sandbox CPU-hours a month, 10 concurrent sandboxes, 45-minute sessions and 15 GB of lifetime Drive storage. Over quota, *all* sandbox creation pauses until the cycle resets. That would stop the team computer too. Harness engines should be refused on Hobby outright **(review)**: over the quota, every new Sandbox pauses, the team computer's included. Hobby function timeouts versus long turns are **(unverified)**.
4. **Maturity.** The package is 0.0.x and the adapters are experimental. Pins are exact, and the Claude Code transcript and Codex rollout formats are CLI internals. Expect breaking changes. Copies update daily to releases (#20), so a bad bump would reach every copy within a day. Pin `durable-harness` exactly and test before tagging.
5. **Keys.** Nothing new beyond the Gateway credential on Vercel. Self-hosted needs a Vercel token on the server. All of it stays in `.env` on his machine, never in the repo, X posts or Discord.
6. **Subscription ToS.** Not in play, since the package bills through Gateway. If anyone asks for "use my Claude Max," the answer is no. Changing that would mean going around the package and reading Anthropic's and OpenAI's terms first.
7. **Data controls.** ZDR and region likely don't apply (4.5). Owners who turned them on must not get harness Bots quietly.
8. **Two kinds of Bot.** One shared computer is part of eve-bot's pitch. A Bot on its own machine without the browser can confuse people. The console has to label it clearly.
9. **Spend visibility.** Until per-step spend from the harness log is wired into `usage`, the usage page lags for those Bots.
10. **Budget overshoot (review).** Several harness jobs at once can each spend up to the per-job limit before the workspace cap notices (4.5). Mid-run checks, or a cap on concurrent harness jobs, close it.
11. **Shell fence on main (review).** `heal()` in the Bot shell helper could be pointed through a link at the computer's own state. Fixed on `fix/heal-shell-fence` before any engine work.

## 6. Milestones

He gave the go on Oct 20, for local branches only. Each step ends with a check.

- **H0. Spike on an eve-bot branch (review).** Two halves.
  - *Offline, no spend:* install `durable-harness` and the Claude Agent SDK at their exact pins, wrap the config with `withDurableHarness`, and check that `npm ls`, typecheck, tests and the build stay clean next to `withEve`, and how big the functions get.
  - *Live, needs his yes on spend:* a script that starts one Claude Code session with no built-ins, `deny-all` network and one `never` HostTool, then answers four questions, each pass or fail: (1) killed mid-turn, did the `never` tool run exactly once? (2) does `sessions.close` stop a running turn? If not, the fallback is `deleteSessionSandbox` on cancel. (3) can spend be read from the log mid-run? That decides between heartbeat checks and a cap on concurrent harness jobs. (4) does the queue route deliver next to eve's service on a real deployment? Cost: Gateway credits and Sandbox time on his account.
- **H0 results (Oct 21, live, on eve-eve-bot's account, $0.016 for two Claude Code sessions).** Run 4 stopped
  because the chaos crash is thrown from a timer and ended the one local process; the spike now catches that one
  crash, so the crashed drive stalls as a dead function's would and the local queue delivers the turn again.
  - (1) a HostTool's `io.ctx.runId` is the session id: **pass**.
  - (2) a live `idle` means the turn ended in the log: **pass**.
  - crashed inside a `never` tool, it ran exactly once after the turn resumed: **pass**.
  - (3) `sessions.close` stops a running turn: **fail in part**. Nothing more is written to the log, but a tool
    already running in the Function is not aborted. So stopping keeps deleting the Sandbox, and the run fence
    refuses whatever the old tool writes.
  - (4) spend is readable mid-run: **pass**, from the log's journal streams. Claude Code writes `hw.spend`, Codex
    writes `codex.spend` (H4 spike), so the heartbeat reads the engine's own stream and the one-at-a-time stopgap
    goes.
  - (5) the queue route on a deployment: not run yet; needs a deployment of the branch with `BOT_ENGINES` set.
- **H4 results (Oct 21, live, $0.004).** `scripts/harness-spike-codex.mts`: one Codex session on
  `openai/gpt-5.4-mini`, no built-ins, `deny-all`: a turn ran, the tool's run id was the session id, the `never`
  tool ran once, spend in `codex.spend`.
- **H1. Engine field, dark (about 1 day).** `Bot.engine`, the owner setting, and run_job's branch behind the switch. No built-ins. Only `job_brief`, `log_progress` and `finish_job` as HostTools. *Check:* tests; a Claude Code Bot finishes a file-only job end to end on his deployment, and cancelling it fences it off.
- **H2. Gates (longer than the first 2 to 3 day guess) (review).** `send_email` and connector writes as gated HostTools through the actions ledger, with the "Needs you" push, a console route and card for approving a ledger proposal, and eve-bot running the approved action itself through `applyAction`. *Check:* a replayed tool doesn't send twice; an approval for changed input is refused; a cancelled run's approval is refused. Same cases as M1's tests.
- **H3. Console (about 2 days).** Engine choice in the hire dialog, the thread rendered from `liveEntries`, the Agent Runs link and spend on the usage page. *Check:* QA run (`npm run qa`), plus a manual pass on desktop and phone.
- **H4. Codex (about 1 day).** The same seam with `codex()`. *Check:* the same suite on a Responses-capable model.
- **H5. Docs and Hobby guard.** The README and `docs/configuration.md` describe costs in words, without made-up numbers, and engines are refused on Hobby (decision 4). *Check:* clean-account deploy on Hobby shows engines unavailable with a clear reason.

The day estimates are guesses, not measurements.

## 7. Decisions for Shaishav

1. **When:** answered Oct 20. Now, on local branches, no push or PR.
2. **Which first:** Claude Code only, or both?
3. **Built-ins (review):** start tool-less, with only eve-bot HostTools (recommended), or turn on Bash, Read, Edit and Write? With `deny-all` network a Coder Bot can't `git clone` or `npm install`, so built-ins only pay off with an allow list. That list is then the real security setting, and every host on it is a way out for data under prompt injection.
4. **Hobby (review):** refuse engines on Hobby outright (recommended), or allow them with a warning? Over the Sandbox quota, every new Sandbox pauses, the team computer's included.
5. **Spike spend:** OK to spend Gateway credits and Sandbox time on the live half of H0?
6. **Positioning:** should "run a Bot on Claude Code" be in public launch copy? It's experimental upstream. Voice would own any post, and nothing goes out under his name without his yes.

## 8. Verdict

It fits. eve-bot already has the right seam (one `send` call in `run_job.ts`), the right fence (job lease plus `guardSideEffect`) and the right idempotency (the actions ledger). `durable-harness`'s `'never'` replay matches how eve-bot already thinks about side effects. Keys stay as they are, since Gateway covers both engines.

It's also experimental on both sides of the dependency. It costs a Sandbox per job, works poorly on Hobby, loses ZDR and region controls, and splits the "one shared computer" story. None of that helps a stranger deploy eve-bot and keep using it. The Oct 18 report found zero verified outside users, with about 10 weeks to Dec 31.

**Recommendation:** the first version of this plan said to park it until the adoption work was done. He chose to start now, on local branches. So: fix `heal()` first, do the offline half of H0, then build H1 dark behind the owner switch with no built-ins. Stop before the live half of H0 until he says yes to the spend. If the live checks hold up, ship H1 to H3 as an owner-only, Pro-only experimental "Coder Bot on Claude Code". Codex follows only if someone asks for it.
