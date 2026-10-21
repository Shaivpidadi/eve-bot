#!/usr/bin/env node
/**
 * D4.1.3 (docs/research/shared-world.md): with a shared Postgres world, does
 * the team's computer follow a conversation from one server process to
 * another? One hop: start a server (`dev`, or `start` on a build made with the
 * same env), have HQ give the generalist a job that appends a line to a file on
 * the computer, wait for it to end, and report what the computer looked like:
 * the Docker container's id and start time, and the file.
 *
 *   SPIKE_ENV=<env file> SPIKE_TOKEN=<console token> node scripts/spikes/computer-hop.mjs dev one
 *   SPIKE_ENV=… SPIKE_TOKEN=… node scripts/spikes/computer-hop.mjs start two
 *
 * The env file exports BOT_WORKFLOW_WORLD=@workflow/world-postgres,
 * WORKFLOW_POSTGRES_URL, BOT_STORE=fs, BOT_DATA_DIR, BOT_COMPUTER=local and
 * BOT_COMPUTER_NAME, and a model (the free Nemotron one does).
 */
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const [mode, label] = process.argv.slice(2);
if (!["dev", "start"].includes(mode ?? "") || !label) {
  console.error("Usage: node scripts/spikes/computer-hop.mjs <dev|start> <label>");
  process.exit(2);
}
const token = process.env.SPIKE_TOKEN;
const envFile = process.env.SPIKE_ENV;
if (!token || !envFile) {
  console.error("Set SPIKE_ENV and SPIKE_TOKEN.");
  process.exit(2);
}
const env = { ...process.env, BOT_CONSOLE_TOKEN: token, BOT_PREWARM_ON_START: "0" };
for (const line of readFileSync(envFile, "utf8").split("\n")) {
  const match = /^(?:export\s+)?([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (match) env[match[1]] = match[2].replace(/^"|"$/g, "");
}
const base = `http://localhost:${env.PORT ?? 3000}`;
const name = env.BOT_COMPUTER_NAME ?? "bot-computer";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const call = async (path, init = {}) => {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers },
    signal: AbortSignal.timeout(120_000),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
};
/** eve names a local computer's container by a hash; its label carries the computer's name. */
const containerId = () =>
  execFileSync("docker", ["ps", "-aq", "--filter", `label=eve.sandbox.tag.agent=${name}`, "--filter", "label=eve.sandbox.role=session"], { encoding: "utf8" })
    .trim()
    .split("\n")[0];
const container = () => {
  try {
    const id = containerId();
    return id ? execFileSync("docker", ["inspect", "--format", "{{.Name}} started {{.State.StartedAt}}", id], { encoding: "utf8" }).trim() : "none";
  } catch {
    return "none";
  }
};
const file = () => {
  try {
    // `docker cp` reads a stopped container too (the computer stops when its server does).
    const tar = execFileSync("docker", ["cp", `${containerId()}:/workspace/shared/hop.txt`, "-"]);
    return JSON.stringify(execFileSync("tar", ["-xO"], { input: tar, encoding: "utf8" }).trim().split("\n"));
  } catch {
    return "missing";
  }
};

const port = env.PORT ?? "3000";
const listener = () => {
  try {
    const pid = execFileSync("lsof", ["-iTCP:" + port, "-sTCP:LISTEN", "-t"], { encoding: "utf8" }).trim().split("\n")[0];
    return pid ? execFileSync("ps", ["-o", "command=", "-p", pid], { encoding: "utf8" }).trim().slice(0, 120) : null;
  } catch {
    return null;
  }
};
// A server left over from an earlier hop would answer in this one's place.
if (listener() !== null) {
  console.error(`Port ${port} is taken (${listener()}); stop that server first.`);
  process.exit(2);
}
const before = { container: container(), file: file() };
spawn("npm", [mode === "dev" ? "run" : "start", ...(mode === "dev" ? ["dev"] : [])], { env, stdio: "ignore", detached: true }).unref();
// eve's dev server and the built one start children of their own, outside any process group: stopped by name, as world-hop.sh does.
const stop = () => {
  for (const pattern of ["next dev", "eve/bin/eve.js", "scripts/start.mjs", ".output/server/index.mjs", "next start"]) {
    try {
      execFileSync("pkill", ["-f", pattern]);
    } catch {
      // Nothing by that name.
    }
  }
};
try {
  for (let i = 0; ; i += 1) {
    const state = await call("/bot/v1/state").catch(() => null);
    if (state?.status === 200) {
      console.log(`served by: ${listener()}`);
      break;
    }
    if (i > 150) throw new Error("the server never came up");
    await sleep(2_000);
  }
  const t0 = Date.now();
  const after = new Date().toISOString();
  await call("/bot/v1/rooms/desk/messages", {
    method: "POST",
    body: JSON.stringify({
      message: `Assign the generalist a job titled exactly "Hop ${label}": in the workspace shell run: mkdir -p /workspace/shared && echo ${label} >> /workspace/shared/hop.txt && cat /workspace/shared/hop.txt. Report what the file holds. Run it now.`,
    }),
  });
  let end = null;
  let jobId = null;
  while (end === null && Date.now() - t0 < 900_000) {
    await sleep(5_000);
    const feed = (await call(`/bot/v1/state?after=${encodeURIComponent(after)}`).catch(() => null))?.body?.activity ?? [];
    jobId ??= feed.find((entry) => entry.kind === "job.assigned" && entry.text.includes(`Hop ${label}`))?.jobId ?? null;
    end = feed.find((entry) => entry.jobId === jobId && ["job.done", "job.failed", "job.blocked"].includes(entry.kind)) ?? null;
  }
  const afterHop = { container: container(), file: file() };
  console.log(
    `${label} (${mode}): ${end === null ? "no end in 15 min" : `${end.kind} in ${Math.round((Date.now() - t0) / 1000)} s`} | container before ${before.container} after ${afterHop.container} | file before ${before.file} after ${afterHop.file}`,
  );
} finally {
  stop();
  await sleep(5_000);
}
