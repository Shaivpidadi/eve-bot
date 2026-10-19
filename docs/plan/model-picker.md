# Plan: choose AI Gateway models in the console

Branch `feat/model-picker` (from `main` after #18). Tags: `[to-do]`, `[in-progress]`, `[done]`, `[parked]`, changed in
the same commit as the work. Conventional Commits, no co-author line.

## Why

Models are chosen only by environment variables (`BOT_HQ_MODEL`, `BOT_TEAMMATE_MODEL`, `BOT_MODEL_QUICK|STANDARD|DEEP`,
`BOT_MEMORY_MODEL`, `BOT_JEV_MODEL`), so trying another model means editing the deployment and redeploying. Vercel AI
Gateway now serves several models at no cost, and the list changes week to week. People should be able to pick from it
in the console, switch the whole team to free models with one toggle, and name any model Gateway serves.

## What Gateway gives us (checked 19 Oct 2026)

- `GET https://ai-gateway.vercel.sh/v1/models` is public (no key). 477 models; 321 `type: "language"`. Each has `id`,
  `name`, `owned_by`, `context_window`, `tags` (`tool-use`, `vision`, `structured-output`, `reasoning`, `free`, …),
  `modalities.input`, `zdr`, and `pricing.input|output` as USD per token, sometimes with `varies_by_provider`.
- Free right now (input and output both `"0"`): `minimax/minimax-m3.1-flash` (tools, vision, structured output),
  `nvidia/nemotron-3.5-lightning-free`, `poolside/laguna-s-2.1-free`, `reflection/beam-free`, `stealth/cat-jam`,
  `stealth/glyph-cluster`. `reflection/beam` also reads `0` but `varies_by_provider`, so it is not reliably free.
  None offers Zero Data Retention.
- From Ship 26 (V7): text-only free models break the browser (it sends screenshots), and Nemotron and Cat Jam could not
  extract memories. A free model with `vision` now exists, so free-only can still use the browser.

## Decisions

- **D1. Per workspace, stored, over the deployment's defaults.** A setting saved in the console wins over the
  environment variables, which stay as the defaults. Stored at `models/<workspaceId>.json`, with each chosen id saved
  next to what the catalog said about it then (free, price, context window, vision, reasoning). Read with a 30 s
  per-process cache: another server instance can keep the old models for up to 30 s, and the page says a change
  applies within about 30 seconds. With a custom endpoint the store is ignored entirely (see D7).
- **D9. A deployment can lock it.** `BOT_MODELS_EDITABLE=off` makes the page read-only, for deployments whose console
  tokens are handed to people who shouldn't pick what the owner's Gateway key pays for. Ids are validated strictly:
  `provider/model`, a safe charset, 120 characters at most.
- **D2. Five roles**, matching how the code already splits work:
  - HQ: the conversation.
  - Bots, standard: most jobs.
  - Bots, quick: lookups and checks.
  - Bots, deep: hard jobs.
  - Helper: memory extraction, Bot intros, roster proposals.

  Each is either "default" (the deployment's) or a model id. Jev is not a role: it calls a decision model
  (`experimental_decide`, a `DecisionModel`), not a chat model, so `BOT_JEV_MODEL` stays env-only.
- **D3. "Free models only" switch.** Off by default, so nothing changes until someone flips it. On:
  - Pickers list only free models.
  - Saving a paid one is refused.
  - Every role that is unset or paid resolves to a free default chosen from the live list: vision and tools first
    (`minimax/minimax-m3.1-flash` today), then any free model with tools.

  Off: the picker lists free models first, then paid ones sorted cheapest first with their prices, so people can pick
  cheaper models for the roles that don't need the best (the "use less" half).

  The free default is chosen **when the setting is saved** and stored with it, so no turn ever waits on Gateway's list.
  `minimax/minimax-m3.1-flash` is the hard-coded fallback when the list can't be read.

  Free-only covers chat models only. Embeddings (`openai/text-embedding-3-small`), Jev's decisions and Gateway web
  search still bill, and the page says so.
- **D4. Any model by name.** The picker's search offers "Use `<typed id>`" for any `provider/model` it doesn't list.
  The save checks the id is shaped right; it is not required to be in the list, since the list can lag and stealth
  models appear and vanish. With free-only on, a typed id must be in the list and free.
- **D5. Warnings where a choice will hurt, never silent:**
  - A Bots role on a model without `vision`: "This model can't see screenshots; browser steps will fail."
  - Helper without `structured-output`: "Memory may not save."
  - `BOT_ZDR` on: a model whose `zdr` is `none` is **refused at save** (Gateway would reject every call), and free-only
    can't be switched on, since no free model offers it.
  - A saved model no longer in Gateway's list: "Gateway no longer lists this model."
- **D6. AI Elements' `model-selector`** (shadcn registry, `npx shadcn add https://registry.ai-sdk.dev/model-selector.json`;
  needs `command` and `dialog`, both installed). Provider marks are drawn as the provider's initial instead of its
  `models.dev` logo, so the console makes no third-party requests.
- **D7. A custom endpoint (`BOT_MODEL_BASE_URL`) keeps env-only.** The page says models come from that endpoint and
  shows them read-only; no Gateway list is fetched.
- **D8. A job keeps its model once started, durably.** `run_job` resolves the model when a run starts and writes it
  into the brief as `model: <id>` next to `effort:`. The teammate reads it from there, so every step of that run
  uses the same model on any instance. A change applies to the next run and to HQ's next turn. HQ resolves on
  `turn.started` only, never per step.

## Tasks

### M1. Gateway catalog `[done]`
- `agent/lib/gateway-models.ts`: `fetchCatalog()` gets the list and keeps `type: "language"` models tagged `tool-use`,
  mapped to `{ id, name, provider, free, inputPerM, outputPerM, context, vision, structured, reasoning, zdr }`. `free`
  means input and output are both `0` and pricing doesn't vary by provider. 10 min in-process cache; on failure the
  last good list, else an empty one with an error.
- `freeDefault(catalog)` returns the best free model: vision and tools, then tools; otherwise the hard-coded fallback.
- Follows the cache and last-good structure of `agent/lib/gateway-account.ts`.
- **Tests:** mapping, free detection (including `varies_by_provider`), ordering, the default pick, and failure falling
  back to the last good list.

### M2. Stored settings and resolution `[done]`
- `agent/lib/model-settings.ts`:
  - `readModelSettings(ws)`, cached 30 s.
  - `saveModelSettings(ws, input, by)`: validates id shape, and under free-only checks each id is listed and free.
  - `resolveModel(ws, role)`: setting, then env, then built-in default, with free-only applied (D3).
- `models.ts`: the env and built-in defaults per role stay the single source.
- **Tests:** precedence, free-only enforcement and fallback, validation, and that the cache is cleared on save.

### M3. Use it everywhere a model is chosen `[done]`
- HQ `agent/agent.ts`: `model: defineDynamic` on `turn.started` only. It returns `{ model, ...gatewayModelOptions() }`
  so ZDR and region still apply, plus `modelContextWindowTokens` from the saved catalog entry (or 128k for an
  unlisted id), and `reasoning: "provider-default"` when the model has no `reasoning` tag. The store is loaded
  lazily, as the teammate does. A custom endpoint keeps today's static model.
- `run_job`: resolves the role for the job's effort and passes it to `renderBrief` (D8). Escalation after a failure is
  skipped when the next effort resolves to the same model (as built: no journal line; the effort stays).
- Teammate: reads `model:` from the brief; falls back to `modelForEffort` (unchanged and synchronous, so
  `tests/models.test.ts` stays valid) for older briefs. Same selection extras as HQ.
- Helper: memory (`capture.ts`), `intro.ts` and `roster.ts` resolve the helper role for their workspace (each has one
  at the call site) and charge usage under the resolved id; `extractionModel()` becomes async at three call sites.
- Budget: `EFFORT_ESTIMATE_USD` assumes the default models. A free resolved model reserves nothing; a paid one keeps
  the estimate (noted as a limit). `EFFORT_DESCRIPTIONS` loses its price ratios, which stop being true.
- Error texts that say "set BOT_TEAMMATE_MODEL" (`models.ts`, `room-store.ts`) point to the Models page.
- **Tests:** `tests/turn-stop.test.ts` exercises the teammate resolver and needs the store mocked.
- **Tests:** the HQ and teammate resolvers return the stored model; helper call sites use it.

### M4. API `[done]`
- `GET /bot/v1/models`: the catalog (or the endpoint's read-only view), the workspace's settings, the deployment
  default per role, the resolved model per role, and the warnings (D5).
- `PUT /bot/v1/models`: save settings and return the same shape. Operator auth, as the other pages use; 403 when
  `BOT_MODELS_EDITABLE=off`.
- **Tests:** route validation and the free-only refusal.

### M5. Console Models page `[done]`
- Add AI Elements `model-selector` (D6).
- `src/console/models-page.tsx`, a sheet like Usage, Memory and Connectors, opened from a sidebar icon and `#models`:
  - The "Free models only" switch, with its trade-offs in one line.
  - One row per role: what it does, the chosen model (name, Free or price per million tokens, capability marks),
    "Default" when unset, and its warning.
  - The picker: search, groups (Free; Paid when allowed), "Use `<typed id>`", "Use the default".
- Custom endpoint: a read-only list of the endpoint's models.
- **Check:** in the browser, change HQ to a free model, switch free-only on and off, type an unlisted id.

### M6. Docs `[done]`
- `docs/configuration.md` (the Models page; env vars as defaults), README models line, `.env.example` comment.

## Review (19 Oct), and what changed

An independent pass against the code raised 14 points. All are folded in above:
- Jev out of Helper.
- The model goes in the brief, not a per-process memo.
- HQ keeps the Gateway options.
- The free default is resolved at save, with a fallback id.
- Context window and reasoning are part of the selection.
- Budget and effort wording are fixed.
- Escalation is skipped when it changes nothing.
- ZDR refuses at save.
- Free-only says what it doesn't cover.
- A lock (D9) and strict ids.
- The endpoint guard.
- The 30 s staleness is stated.
- HQ resolves per turn, not per step.
- Error texts and tests are updated.

Checked by hand since:
- The free MiniMax model takes real screenshots (named both colours of a 400×200 image, sent as bytes, a data URL,
  and a file part).
- It calls tools.
- It extracts memories: 3 of 4 answers well-formed, all 3 facts found.
- The other free models fail one or more of those.

## Checked live (19 Oct 2026, a worktree on :3200, free models, local Docker computer)
- **The page:**
  - The Gateway list loads, with 255 tool-capable models once batch-only variants are left out.
  - The picker searches, lists free models first, prices paid ones, and offers "Use `<typed id>`" for an unlisted id.
  - Picking MiniMax for Bots (standard) cleared that row's screenshot warning.
  - "Free models only" puts every role on MiniMax, as the free default.
- **A job under free-only** ran on `minimax/minimax-m3.1-flash` (14 steps, $0): it opened example.com, read it, and
  ran the shell. Memory saved two lessons through the free helper; only embeddings billed (about $0.00002).
- **Found and fixed live:**
  - The dev server crashed. `run_job` pulled the store into the workflow bundle through a plain helper; the model is
    now resolved inside the claim step.
  - A teammate read its effort and model from the *first* user message, but eve puts memory instructions first, so
    every job had been running at the standard effort's model (masked by `BOT_TEAMMATE_MODEL`). It now reads the
    message with the job's section.
  - Batch-only Gateway models were listed; they are now left out (they can still be named).

## Verification
- Every task: `npm run typecheck`, `npx vitest run`, `BOT_SKIP_SANDBOX_PREWARM=1 npm run build`.
- Live, on free models (local, a worktree on :3200):
  - Pick HQ, Bots and Helper models in the page; a conversation and a job run on them (the usage ledger names the
    models).
  - Free-only on: every role resolves free, and a browser job on the vision-capable free model sees the page.
  - Memory with the free default: record whether it saves.
- Local mode unchanged: with no settings saved, the models are exactly today's.
