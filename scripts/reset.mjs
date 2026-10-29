#!/usr/bin/env node
/**
 * `npm run reset`: a standalone or dev copy of Bot back to zero.
 *
 * Moves the two places local state lives into `.trash/<time>/` rather than
 * deleting them, so a reset is a `mv` away from undone:
 * - `.eve/.workflow-data`: eve's sessions, meaning every HQ and Bot thread;
 * - `.data` (or BOT_DATA_DIR): roster, jobs, activity, memory, screens, and
 *   the computer's manifest and backups.
 *
 * The team's computer itself is left alone: a Docker container named
 * BOT_COMPUTER_NAME is found again by name and keeps its browser and
 * sign-ins. Pass --computer to remove it too, for a fresh machine.
 *
 * Refuses while `npm run dev` or `npm start` is running, since both hold the
 * session store open. On Vercel none of this applies; there, new values for
 * BOT_STORE_PREFIX, BOT_DEFAULT_WORKSPACE, and BOT_COMPUTER_NAME do the same.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

import nextEnv from "@next/env";

nextEnv.loadEnvConfig(process.cwd(), false);

const root = process.cwd();
const dataDir = process.env.BOT_DATA_DIR?.trim() || join(root, ".data");
const workflowData = join(root, ".eve", ".workflow-data");
const computerName = process.env.BOT_COMPUTER_NAME ?? "bot-computer";
const withComputer = process.argv.includes("--computer");

const SERVER = /eve[\\/]bin[\\/]eve\.js|local-server-child\.js|next dev|next[\\/]dist[\\/]bin[\\/]next"? (dev|start)|\.output[\\/]server[\\/]index\.mjs|scripts[\\/]start\.mjs/;

/** Whether a Bot server is running here: every Node process's command line, by `ps`, or PowerShell on Windows. */
function running() {
  try {
    const lines =
      process.platform === "win32"
        ? execFileSync("powershell", ["-NoProfile", "-Command", "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | ForEach-Object { \"$($_.ProcessId) $($_.CommandLine)\" }"], { encoding: "utf8" })
        : execFileSync("ps", ["-eo", "pid=,args="], { encoding: "utf8" });
    return lines
      .split(/\r?\n/)
      .map((line) => line.trim().match(/^(\d+)\s+(.*)$/))
      .some((match) => match !== null && Number(match[1]) !== process.pid && Number(match[1]) !== process.ppid && SERVER.test(match[2]));
  } catch {
    return false;
  }
}

if (running()) {
  console.error("Bot is running. Stop `npm run dev` or `npm start` first, then run this again.");
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const trash = join(root, ".trash", stamp);
mkdirSync(trash, { recursive: true });

let moved = 0;
for (const [label, path] of [["eve sessions", workflowData], ["workspace data", dataDir]]) {
  if (!existsSync(path)) continue;
  renameSync(path, join(trash, label.replace(" ", "-")));
  console.log(`moved ${label} (${path}) to ${trash}`);
  moved += 1;
}
// Dev-server bookkeeping that points at the sessions just moved.
for (const name of ["dev-runtime", "dev-hosts", "locks", "dev-server-state.v1.json", "next-dev-server.json"]) {
  rmSync(join(root, ".eve", name), { recursive: true, force: true });
}

if (withComputer) {
  const docker = process.env.EVE_DOCKER_PATH ?? "docker";
  // eve names the computer's container by a hash and labels it with the computer's name; the live view's forwarder goes by name.
  let containers = [`${computerName}-gateway`];
  try {
    const labelled = execFileSync(docker, ["ps", "-aq", "--filter", `label=eve.sandbox.tag.agent=${computerName}`], { encoding: "utf8" });
    containers = [...labelled.split(/\s+/).filter((id) => id !== ""), ...containers];
  } catch {
    // No Docker: nothing to remove.
  }
  for (const name of containers) {
    try {
      execFileSync(docker, ["rm", "-f", name], { stdio: "ignore" });
      console.log(`removed container ${name}`);
    } catch {
      // Not there: nothing to remove.
    }
  }
} else {
  console.log(`kept the team's computer (${computerName}); pass --computer for a fresh machine without its sign-ins`);
}

console.log(moved === 0 ? "Nothing to reset." : `Reset. Start again with npm run dev or npm run build && npm start.`);
