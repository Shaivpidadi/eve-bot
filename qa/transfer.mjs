#!/usr/bin/env node
/**
 * The transfer check (durable-runs D2.2): a workspace moves from a deployment
 * to a laptop with nothing lost but its live runs, and its open job picks up
 * again on its own.
 *
 *   QA_URL=https://scratch.example QA_TOKEN=… [QA_BYPASS=…] npm run qa:transfer
 *
 * 1. Seeds the deployment: a Bot, a team memory, and a job that runs a while.
 * 2. Exports the workspace over HTTP (`/bot/v1/export`, turned on for the run
 *    and back off after) once the job has started.
 * 3. Imports it into a fresh local store with `npm run import`.
 * 4. Starts a local server on that store, from a git worktree of this commit so
 *    its eve state is its own, and checks the Bot and the memory are there,
 *    the job's thread says it moved, and a sweep starts it again. Records how
 *    long that took: the plan's "time to first re-dispatch".
 *
 * The local server runs on the checkout's .env (its model settings) with a
 * Docker computer of its own, removed at the end.
 *
 * It leaves fixtures on the deployment and cancels the job there, so point it
 * at a scratch deployment only; like `npm run qa`, it refuses the "default"
 * workspace unless QA_ALLOW_DEFAULT=1. It spends a little: HQ's turn on the
 * deployment, and the job's first steps there and here.
 */
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { client, expect } from "./harness.mjs";
import { feed, waitFor, waitForJobEvent } from "./lib/wait.mjs";

const url = process.env.QA_URL?.trim();
const token = process.env.QA_TOKEN?.trim();
if (!url || !token) {
  console.error("QA_URL and QA_TOKEN are required: the deployment the workspace moves from.");
  process.exit(2);
}
const port = Number(process.env.QA_TRANSFER_PORT) || 3471;
const source = client({ url, token, timeoutMs: 120_000 });
const root = process.cwd();
const scratch = mkdtempSync(join(tmpdir(), "bot-transfer-"));
const tag = Date.now().toString(36);
const steps = [];
const step = (line) => {
  steps.push(line);
  console.log(`  ✓ ${line}`);
};

let server = null;
let worktree = null;
let exportWasOn = null;
let jobId = null;
try {
  const state = await source("/bot/v1/state");
  expect(state.status, 200, "opening the deployment", { body: state.body });
  const workspace = state.body.workspaceId;
  if (workspace === "default" && process.env.QA_ALLOW_DEFAULT !== "1") {
    console.error('This token opens the "default" workspace. Point the transfer check at a scratch deployment, or set QA_ALLOW_DEFAULT=1 on one.');
    process.exit(2);
  }
  console.log(`Transfer · ${url} → a local store · workspace ${workspace}\n`);

  // 1. What has to arrive.
  const name = `Mover ${tag}`;
  const hired = await source("/bot/v1/bots", {
    method: "POST",
    body: { name, role: "Moves with the workspace", persona: "A QA fixture for the transfer check. Plain and brief." },
  });
  expect(hired.status, (status) => status < 300, "hiring the Bot that has to arrive", { body: hired.body });
  const marker = `QA transfer marker ${tag}: the workspace moved with its memory.`;
  const remembered = await source("/bot/v1/memory/team", { method: "POST", body: { text: marker, kind: "fact" } });
  expect(remembered.status, 201, "writing the memory that has to arrive", { body: remembered.body });
  const after = new Date().toISOString();
  const room = `qa-transfer-${tag}`;
  const asked = await source(`/bot/v1/rooms/${room}/messages`, {
    method: "POST",
    body: {
      message: `Assign a job to ${name} titled exactly "QA transfer ${tag}": in your workspace run the shell command "for i in 1 2 3 4 5 6; do sleep 20; echo tick $i; done", log progress after it finishes, then finish. Do not use the browser. Run it now.`,
    },
  });
  expect(asked.status, (status) => status < 400, "asking HQ for the job", { body: asked.body });
  const assigned = await waitFor(async () => (await feed(source, after)).find((entry) => entry.kind === "job.assigned" && entry.text.includes(tag)), {
    until: (entry) => entry !== undefined,
    what: "the job to be assigned",
    timeoutMs: 180_000,
  });
  jobId = assigned.jobId;
  await waitForJobEvent(source, after, jobId, ["job.started"], { what: "the job to start on the deployment", timeoutMs: 240_000 });
  step(`seeded ${name}, a memory, and job ${jobId}, running`);

  // 2. Out of the deployment, mid-run.
  const settings = await source("/bot/v1/settings");
  exportWasOn = /^(on|1|true)$/i.test(settings.body?.settings?.find((setting) => setting.env === "BOT_EXPORT")?.value ?? "");
  if (!exportWasOn) {
    const on = await source("/bot/v1/settings", { method: "PUT", body: { changes: { BOT_EXPORT: "on" } } });
    expect(on.status, 200, "turning exports on for the run", { body: on.body });
  }
  const file = join(scratch, "workspace.bot.gz");
  const exported = await waitFor(
    () =>
      fetch(`${url.replace(/\/+$/, "")}/bot/v1/export?secrets=1`, {
        headers: { authorization: `Bearer ${token}`, ...(process.env.QA_BYPASS ? { "x-vercel-protection-bypass": process.env.QA_BYPASS } : {}) },
        signal: AbortSignal.timeout(120_000),
      }),
    { until: (response) => response.status !== 404, what: "exports to be on (settings apply within about 30 seconds)", timeoutMs: 90_000, everyMs: 10_000 },
  );
  expect(exported.status, 200, "exporting the workspace", { status: exported.status });
  const bytes = Buffer.from(await exported.arrayBuffer());
  writeFileSync(file, bytes);
  step(`exported ${Math.round(bytes.length / 1024)} KB`);
  // The job goes on running on the deployment; it is the laptop's from here.
  await source(`/bot/v1/jobs/${jobId}`, { method: "DELETE" }).catch(() => undefined);

  // 3. Into a fresh local store.
  const data = join(scratch, "data");
  // A computer of its own on Docker, so the picked-up run never touches the laptop's usual one.
  const env = {
    ...process.env,
    BOT_STORE: "fs",
    BOT_DATA_DIR: data,
    BOT_DEFAULT_WORKSPACE: workspace,
    BOT_CONSOLE_TOKEN: "",
    BOT_CONSOLE_TOKENS: "",
    BOT_COMPUTER: "local",
    BOT_COMPUTER_NAME: `bot-transfer-${tag}`,
  };
  const importedAt = new Date().toISOString();
  const imported = execFileSync("npx", ["tsx", "scripts/import.mjs", "--in", file], { cwd: root, env, encoding: "utf8" });
  expect(/Wrote \d+ keys/.test(imported), true, "the import says what it wrote", { imported });
  expect(/^[1-9]\d* open job/m.test(imported), true, "the running job is to be re-dispatched", { imported });
  step(`imported: ${imported.trim().split("\n").join(" ")}`);

  // 4. A local server on it, from a worktree of this commit so its eve sessions are its own.
  worktree = join(scratch, "checkout");
  execFileSync("git", ["worktree", "add", "--detach", worktree, "HEAD"], { cwd: root, stdio: "ignore" });
  // Turbopack refuses a node_modules symlinked from outside the checkout; a copy-on-write clone (APFS, btrfs) is quick and small.
  execFileSync("cp", process.platform === "darwin" ? ["-cR", join(root, "node_modules"), worktree] : ["-R", "--reflink=auto", join(root, "node_modules"), worktree]);
  // The checkout's own model settings (.env is not in git), for the run that picks the job up.
  if (existsSync(join(root, ".env"))) symlinkSync(join(root, ".env"), join(worktree, ".env"));
  const started = Date.now();
  const log = [];
  server = spawn("npx", ["next", "dev", "-p", String(port)], { cwd: worktree, env, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.on("data", (chunk) => log.push(String(chunk)));
  server.stderr.on("data", (chunk) => log.push(String(chunk)));
  const local = client({ url: `http://localhost:${port}`, token: "", workspace, timeoutMs: 240_000 });
  const opened = await waitFor(() => local("/bot/v1/state").catch(() => ({ status: 0 })), { until: (response) => response.status === 200, what: "the local server", timeoutMs: 300_000, everyMs: 5_000 }).catch((error) => {
    throw new Error(`${error.message}\n--- the local server said ---\n${log.join("").slice(-3_000)}`);
  });
  const ready = Date.now();
  step(`local server up in ${Math.round((ready - started) / 1000)} s`);

  expect(opened.body.members?.some((member) => member.name === name), true, "the Bot arrived", { members: opened.body.members?.map((member) => member.name) });
  const memory = await local("/bot/v1/memory");
  expect(JSON.stringify(memory.body).includes(marker), true, "the memory arrived", { status: memory.status });
  const moved = await local(`/bot/v1/jobs/${jobId}`);
  expect(moved.status, 200, "the job arrived", { body: moved.body });
  step("the Bot, the memory and the job arrived");

  const swept = await local("/bot/v1/jobs/sweep", { method: "POST" });
  expect(swept.status, 200, "sweeping on the laptop", { body: swept.body });
  // From before the import, which writes the job's "moved" line; the run itself starts after the server is up.
  const again = await waitForJobEvent(local, importedAt, jobId, ["job.started"], { what: "the job to start again on the laptop", timeoutMs: 300_000 });
  expect(again.events.some((entry) => entry.kind === "job.moved"), true, "the job's thread says it moved", { events: again.events.map((entry) => entry.kind) });
  const redispatch = Date.parse(again.event.at) - ready;
  step(`the job's thread says it moved, and it started again on the laptop ${Math.round(redispatch / 1000)} s after the server came up`);
  await local(`/bot/v1/jobs/${jobId}`, { method: "DELETE" }).catch(() => undefined);
  console.log(`\nTransfer passed: ${steps.length} steps; time to first re-dispatch ${Math.round(redispatch / 1000)} s.`);
} catch (error) {
  console.error(`\n  ✗ ${error instanceof Error ? error.message : String(error)}`);
  if (error?.evidence) console.error(JSON.stringify(error.evidence).slice(0, 2_000));
  process.exitCode = 1;
} finally {
  server?.kill("SIGTERM");
  // eve's dev server starts children outside the process; stopped by the checkout's path.
  if (worktree !== null) {
    try {
      execFileSync("pkill", ["-f", worktree]);
    } catch {
      // Already gone.
    }
    try {
      const ids = execFileSync("docker", ["ps", "-aq", "--filter", `label=eve.sandbox.tag.agent=bot-transfer-${tag}`], { encoding: "utf8" }).trim();
      if (ids) execFileSync("docker", ["rm", "-f", ...ids.split("\n")], { stdio: "ignore" });
    } catch {
      // No computer was started.
    }
  }
  if (exportWasOn === false) await source("/bot/v1/settings", { method: "PUT", body: { changes: { BOT_EXPORT: null } } }).catch(() => undefined);
  if (worktree !== null) {
    try {
      execFileSync("git", ["worktree", "remove", "--force", worktree], { cwd: root, stdio: "ignore" });
    } catch {
      // Removed with the scratch folder below; `git worktree prune` tidies the record.
    }
  }
  rmSync(scratch, { recursive: true, force: true });
}
