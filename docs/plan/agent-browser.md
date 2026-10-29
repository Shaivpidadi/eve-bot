# Plan: more of agent-browser

Branch `feat/agent-browser` (from `feat/telegram`). Tags: `[to-do]`, `[in-progress]`, `[done]`, `[parked]`,
changed in the same commit as the work.

## Where we start

Bots already use agent-browser for everything they do in the browser: every `page_*` tool is an agent-browser
command (`snapshot`, `click @e2`, `fill`, `find`, `wait`, `tabs`, `network`, `stream`) against the team computer's
Chrome over DevTools, through `@agent-browser/eve` (`agent/subagents/teammate/lib/browser.ts`). The computer image
pins the CLI (`agent/sandbox/Dockerfile`).

What 0.40 (27 Oct) adds, and what we take from it. Checked by hand against a local Chrome 156 on 28 Oct:

- **Batch**: several commands in one call, answering a JSON array of `{command, success, result, error}`.
  Without `--bail` every command runs, and the CLI exits 1 if any failed (the array is still printed).
- **WebMCP**: a page can offer its own tools (`document.modelContext.registerTool`). `webmcp list --json`
  gives name, description, input schema, annotations and frame; `webmcp invoke <tool> --frame <id> --params <json>`
  calls it. It works over `--cdp` on a Chrome we launch only when Chrome was started with
  `--enable-features=WebMCPTesting,DevToolsWebMCPSupport`.
- **Recording**: `record start <file.webm> --fps N` / `record stop`, through ffmpeg. It records the session's tab
  **only while that tab is on screen**: a background tab gave 1 distinct frame in 12 (the front tab 9 in 18).
  Bots share one browser, so a Bot whose tab is behind another's records a still picture for that stretch.
- **Diff**: `diff snapshot` compares the page with the last snapshot. We already do this ourselves
  (`compareTrees` in `lib/page.ts`), with more than it gives: refs that were renumbered, a new page told apart
  from a changed one, and lines capped for the model. Nothing to adopt.

## Tasks

### A1. agent-browser 0.40 `[done]`
- `[done]` `@agent-browser/sandbox` 0.40.0 (the install spec `@agent-browser/eve` reads), the Dockerfile's pin.
- `[done]` A computer that already has 0.39 is moved to 0.40 the first time a run uses the browser, instead of
  keeping the old CLI until the machine is replaced.
- **Done when:** `tests/computer-image.test.ts` passes with the new pin, and a unit test covers the version check.

### A2. One call to read the page `[done]`
- `[done]` `look()` (after every action and every `page_snapshot`) runs its four commands (`wait --load`,
  the settle wait, `snapshot -c`, `get url`) as one `batch`: one round trip to the computer instead of four.
- `[done]` A batch whose command failed still gives the others' results (the CLI exits 1).
- **Done when:** unit tests cover reading a batch answer, a failed step in it, and output that is not a batch.

### A3. Page tools (WebMCP) `[done]`
- `[done]` Chrome starts with WebMCP on (`CHROME_FLAGS` in `computer/script.ts`); a browser started before
  picks it up when it next starts, and the tool says so meanwhile.
- `[done]` `page_tools`: the tools the page offers (name, description, frame), or one tool's input schema.
- `[done]` `page_tool`: call one. Through the same gate as a click: a tool whose name or description reads
  like send, pay, delete or publish, or that calls itself destructive, waits for a person (`page_confirm`);
  any other runs with the network guard on, and becomes a proposal if it tries to send anything but a read.
  The page's own `readOnlyHint` never lets anything through.
- `[done]` `page_confirm` carries out an approved tool call only if the page is the same and the tool still
  says the same thing (name, description and schema).
- **Done when:** unit tests cover the classification, the proposal's description, and the drift check.
  Done: `tests/agent-browser.test.ts` and the fake shop in `tests/browser-gate.test.ts`.

### A4. Recording a job's browser `[done]`
- `[done]` Setting `BOT_BROWSER_RECORDING` (off by default, Settings → Browser): a job's browser work is
  recorded at a few frames a second into its folder on the computer.
- `[done]` ffmpeg is installed on the computer the first time it is needed (it is large; most teams won't).
- `[done]` When the job finishes the recording is saved with its artifacts, so it is on the job's page.
- `[done]` Docs say what it shows: the Bot's tab while it is on screen.
- **Done when:** unit tests cover start/stop bookkeeping and the setting; a live run shows the video.
  Unit tests done; the live run is in the live check below. Found while testing: closing a tab ends its
  recording cleanly (ffmpeg exits, the file plays), so the tab sweep finishes the recordings of jobs that
  were cancelled or failed; those are not kept. A recording longer than the 2 MB artifact limit is stored
  apart (`saveLargeArtifact`, up to 50 MB) and plays from the job's files.

### A5. Docs `[done]`
- `[done]` `docs/configuration.md` (recording), `docs/safety.md` (page tools through the gate), the README.

### A6. eve 0.86 `[done]`
`@agent-browser/eve` 0.40 needs eve 0.84 or later, which moved eve to new session events ("v27") and
renamed hooks, approvals and channel APIs. Done on this branch, at the user's word.

- `[done]` Dynamic instructions, connections and models: `defineDynamic(ctx => value)`, with the
  once-a-turn lookups kept in `ctx.memo` (`lib/dynamic.ts`). HQ keeps its model for a turn; a job for its session.
- `[done]` Hooks on v27 facts: the ledgers on `usage.recorded` (a delegated call's spend left to the
  agent it called), the feed and room state on `delivery.consumed` / `content.completed` /
  `turn.settled` / `interaction.*`, memory capture, the takeover banner, tab closing.
- `[done]` The team computer's provider on eve's connection API; sandbox calls take `signal`, not
  `abortSignal` (so command timeouts and cancellation still apply, agent-browser's included).
- `[done]` microsandbox removed (eve dropped it); `BOT_COMPUTER_LOCAL=microsandbox` is refused with a message.
- `[done]` The ops channel: deliveries, `respond` with answers by `interactionId`, sessions read with
  `stream()`. The thread stream tags each event with a key and a cursor that run across a thread's
  sessions (`inThread` in `lib/events.ts`), and branching names its point by that key.
- `[done]` The console reads v27 facts (`room-store.ts`), with the cards fed by `src/console/asks.ts`.
- `[done]` `tests/turn-stop.test.ts` drove eve's own turn loop, which no longer evaluates dynamic
  values itself; it now holds the guarantee at the boundary eve documents (the model is refused for a
  stopped run). Since 0.84 compaction's summarising call skips dynamic values, so a stopped run can be
  compacted once.
- `[done]` `docs/updating.md`: what an upgrade does to conversations, and microsandbox.

Found while checking: booting the build against the project's local workflow data (`.eve/.workflow-data`)
marks it with world-local 5.1.2 (a marker only; 0.82 still reads it) and ends Bot job sessions left from
0.82, which this release does on its first start anyway.

## Live check `[to-do]`
On a Docker computer: a Bot reads a page (one batch), calls a page tool, and a recorded job shows its video.
After eve 0.86: a message to HQ streams into the console, an approval card answers, going back to a
message works, a Telegram message gets its reply and its buttons.
