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

function running() {
  try {
    const out = execFileSync("pgrep", ["-f", "eve/bin/eve.js|local-server-child.js|next dev|\\.output/server/index\\.mjs"], { encoding: "utf8" });
    return out.trim().split("\n").filter((pid) => pid !== "" && Number(pid) !== process.pid && Number(pid) !== process.ppid).length > 0;
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
  for (const name of [computerName, `${computerName}-gateway`]) {
    try {
      execFileSync(process.env.EVE_DOCKER_PATH ?? "docker", ["rm", "-f", name], { stdio: "ignore" });
      console.log(`removed container ${name}`);
    } catch {
      // Not there, or no Docker: nothing to remove.
    }
  }
} else {
  console.log(`kept the team's computer (${computerName}); pass --computer for a fresh machine without its sign-ins`);
}

console.log(moved === 0 ? "Nothing to reset." : `Reset. Start again with npm run dev or npm run build && npm start.`);
