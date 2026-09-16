#!/usr/bin/env node
/**
 * `npm start`: a standalone Bot server.
 *
 * Two processes make one deployment: the agent that `eve build` wrote to
 * `.output/` (HQ, the Bots, the console API, and the schedule runner), and the
 * Next.js console, whose build rewrote `/eve/v1` and `/bot/v1` to the agent on
 * 127.0.0.1:4274 (`EVE_NEXT_PRODUCTION_PORT`, which must match at build time).
 * Both read `.env` the way Next.js does. When either stops, so does the other,
 * and the agent stops the team's computer on the way out and reattaches to it
 * on the next start.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import nextEnv from "@next/env";

nextEnv.loadEnvConfig(process.cwd(), false);

const agentEntry = join(process.cwd(), ".output", "server", "index.mjs");

// In a container the agent builds here rather than in the image, because it
// decides a few things (which web search, which model endpoint) from the
// environment it starts with. BOT_BUILD_ON_START=1 asks for that; a missing
// build gets one either way.
if (process.env.BOT_BUILD_ON_START === "1" || !existsSync(agentEntry)) {
  console.log("[bot] Building the agent...");
  const built = spawnSync(join(process.cwd(), "node_modules", ".bin", "eve"), ["build"], { stdio: "inherit" });
  if (built.status !== 0) {
    console.error("[bot] The agent did not build; see above.");
    process.exit(built.status ?? 1);
  }
}
if (!existsSync(agentEntry)) {
  console.error("[bot] No agent build at .output/. Run `npm run build` first.");
  process.exit(1);
}

// A production server never builds a sandbox template on demand; eve expects
// them provisioned before it serves traffic, and `eve build` does that only
// for Vercel. So the team's computer's template is built here, with the same
// API eve's own build hook uses: minutes the first time (Chrome and a desktop
// are installed into it), seconds after, since it is a cached Docker image.
// BOT_PREWARM_ON_START=0 skips it, for a host that provisions another way.
if (process.env.BOT_PREWARM_ON_START !== "0" && process.env.BOT_COMPUTER === "local") {
  console.log("[bot] Provisioning the team's computer template...");
  try {
    const { prewarmBuiltAppSandboxes } = await import(
      pathToFileURL(join(process.cwd(), "node_modules", "eve", "dist", "src", "execution", "sandbox", "prewarm.js")).href
    );
    await prewarmBuiltAppSandboxes({ appRoot: process.cwd(), log: (line) => console.log(`[bot] ${line}`) });
  } catch (error) {
    console.error(`[bot] Could not provision the computer template: ${error instanceof Error ? error.message : String(error)}`);
    console.error("[bot] The first job will fail until it exists. Is Docker running?");
  }
}

const agentPort = process.env.EVE_NEXT_PRODUCTION_PORT?.trim() || "4274";
const consolePort = process.env.PORT?.trim() || "3000";
const host = process.env.HOST?.trim() || "0.0.0.0";

const children = [
  spawn(process.execPath, [agentEntry], {
    stdio: "inherit",
    env: { ...process.env, HOST: "127.0.0.1", NITRO_HOST: "127.0.0.1", PORT: agentPort, NITRO_PORT: agentPort },
  }),
  spawn(process.execPath, [join(process.cwd(), "node_modules", "next", "dist", "bin", "next"), "start", "-H", host, "-p", consolePort], {
    stdio: "inherit",
    env: { ...process.env, NODE_ENV: "production" },
  }),
];

let stopping = false;

function stop(code, signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null) child.kill(signal);
  // The agent stops the team's computer before it exits; give it a moment.
  setTimeout(() => process.exit(code), 15_000).unref();
  let open = children.filter((child) => child.exitCode === null).length;
  if (open === 0) process.exit(code);
  for (const child of children) {
    child.once("exit", () => {
      open -= 1;
      if (open === 0) process.exit(code);
    });
  }
}

for (const child of children) {
  child.on("exit", (code, signal) => {
    if (stopping) return;
    console.error(`[bot] ${child === children[0] ? "agent" : "console"} exited (${signal ?? code}); stopping.`);
    stop(code ?? 1);
  });
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => stop(0, signal));
