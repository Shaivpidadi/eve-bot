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

### A3. Page tools (WebMCP) `[to-do]`
- `[to-do]` Chrome starts with WebMCP on (`CHROME_FLAGS` in `computer/script.ts`); a browser started before
  picks it up when it next starts, and the tool says so meanwhile.
- `[to-do]` `page_tools`: the tools the page offers (name, description, frame), or one tool's input schema.
- `[to-do]` `page_tool`: call one. Through the same gate as a click: a tool whose name or description reads
  like send, pay, delete or publish, or that calls itself destructive, waits for a person (`page_confirm`);
  any other runs with the network guard on, and becomes a proposal if it tries to send anything but a read.
  The page's own `readOnlyHint` never lets anything through.
- `[to-do]` `page_confirm` carries out an approved tool call only if the page is the same and the tool still
  says the same thing (name, description and schema).
- **Done when:** unit tests cover the classification, the proposal's description, and the drift check.

### A4. Recording a job's browser `[to-do]`
- `[to-do]` Setting `BOT_BROWSER_RECORDING` (off by default, Settings → Browser): a job's browser work is
  recorded at a few frames a second into its folder on the computer.
- `[to-do]` ffmpeg is installed on the computer the first time it is needed (it is large; most teams won't).
- `[to-do]` When the job finishes the recording is saved with its artifacts, so it is on the job's page.
- `[to-do]` Docs say what it shows: the Bot's tab while it is on screen.
- **Done when:** unit tests cover start/stop bookkeeping and the setting; a live run shows the video.

### A5. Docs `[to-do]`
- `[to-do]` `docs/configuration.md` (recording), the browser section of the README (page tools).

### A6. eve 0.86 `[parked]`
`@agent-browser/eve` 0.40 needs eve 0.84 or later. That release moved eve to new session events ("v27"),
with renamed hooks, approvals and channel APIs. About 40 of our files use the old names, including the
Telegram channel, and sessions that already exist are compacted when they move over. Nothing above needs it:
the CLI is what changed, and we call it through `@agent-browser/sandbox`. It gets its own branch and plan.

## Live check `[to-do]`
On a Docker computer: a Bot reads a page (one batch), calls a page tool, and a recorded job shows its video.
