#!/usr/bin/env node
/**
 * `npm start`: a standalone Bot server.
 *
 * Two processes make one deployment: the agent that `eve build` wrote to
 * `.output/` (HQ, the Bots, the console API, and the schedule runner), and the
 * Next.js console, whose build rewrote `/eve/v1` and `/bot/v1` to the agent on
 * 127.0.0.1:4274 (`EVE_NEXT_PRODUCTION_PORT`, which must match at build time).
 * Since eve 0.82, `next start` starts that agent itself (`withEve`), with the
 * console's environment, and stops it when the console stops; starting a
 * second one here as well left two fighting for the port. So this script
 * prepares the environment (`.env`, saved settings, a build when one is due)
 * and starts the console. The agent stops the team's computer on the way out
 * and reattaches to it on the next start.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import nextEnv from "@next/env";

import { overlaySettings, savedSettings } from "./settings.mjs";

nextEnv.loadEnvConfig(process.cwd(), false);

// Settings saved in the console that the agent's build fixes (caps, where the
// computer runs) win over .env; a change since the last build rebuilds it.
const plan = savedSettings("plan");
overlaySettings(plan?.overlay);

const agentEntry = join(process.cwd(), ".output", "server", "index.mjs");

// A production server never builds the team computer's template on demand, and
// since eve 0.79 `eve build` makes it (a Docker image, minutes the first time,
// seconds after) and records it in .output/. A build made without it (such as
// `npm run build` with BOT_SKIP_SANDBOX_PREWARM=1) is built again here for a
// local computer. BOT_PREWARM_ON_START=0 skips that, for a host that
// provisions the template another way.
const prepared = join(process.cwd(), ".output", ".eve", "compile", "sandbox-prepared-artifacts.json");
const templateMissing = process.env.BOT_PREWARM_ON_START !== "0" && process.env.BOT_COMPUTER === "local" && !existsSync(prepared);

// In a container the agent builds here rather than in the image, because it
// decides a few things (which web search, which model endpoint) from the
// environment it starts with. BOT_BUILD_ON_START=1 asks for that; a missing
// build gets one either way.
const needed = process.env.BOT_BUILD_ON_START === "1" || !existsSync(agentEntry) || plan?.changed === true;
if (needed || templateMissing) {
  console.log(
    needed
      ? plan?.changed === true && existsSync(agentEntry)
        ? "[bot] Settings changed since the last build; building the agent again..."
        : "[bot] Building the agent..."
      : "[bot] Building the agent with the team computer's template...",
  );
  // eve's own entry, run by this Node, as on every platform (`.bin/eve` is a `.cmd` on Windows).
  const built = spawnSync(process.execPath, [join(process.cwd(), "node_modules", "eve", "bin", "eve.js"), "build"], { stdio: "inherit" });
  if (built.status === 0) savedSettings("record");
  else if (needed) {
    console.error("[bot] The agent did not build; see above.");
    process.exit(built.status ?? 1);
  } else {
    // The build that is there still serves; only the computer is missing.
    console.error("[bot] Could not build the computer's template; see above. The first job will fail until it exists. Is Docker running?");
  }
}
if (!existsSync(agentEntry)) {
  console.error("[bot] No agent build at .output/. Run `npm run build` first.");
  process.exit(1);
}

const agentPort = process.env.EVE_NEXT_PRODUCTION_PORT?.trim() || "4274";
const consolePort = process.env.PORT?.trim() || "3000";
const host = process.env.HOST?.trim() || "0.0.0.0";

// NODE_ENV is what tells the agent it is serving rather than being developed:
// without it a server started here treats itself as a dev box and, with no
// console token set, leaves /bot/v1 open to anyone who can reach the port.
// A job whose run was lost to the restart (a rebuild strands it on a local
// Workflow world) is picked up by a sweep a minute after boot rather than by
// the daily tick. BOT_TICK_ON_START=off leaves it to the cron.
if (process.env.BOT_TICK_ON_START !== "off") {
  const token = process.env.BOT_CONSOLE_TOKEN?.trim() || process.env.BOT_CONSOLE_TOKENS?.split(",")[0]?.split("=")[0]?.trim();
  setTimeout(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${agentPort}/bot/v1/jobs/sweep`, {
        method: "POST",
        headers: token ? { authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(60_000),
      });
      const body = await response.json().catch(() => null);
      if (response.ok && body?.swept) console.log(`[bot] start sweep: ${body.due} due, ${body.dispatched} dispatched${body.stranded ? `, ${body.stranded} stranded by the restart` : ""}`);
      else if (!response.ok) console.warn(`[bot] start sweep: ${response.status}`);
    } catch (error) {
      console.warn(`[bot] start sweep failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, 60_000).unref();
}

// The console, which starts the agent (above) with this environment.
const children = [
  spawn(process.execPath, [join(process.cwd(), "node_modules", "next", "dist", "bin", "next"), "start", "-H", host, "-p", consolePort], {
    stdio: "inherit",
    env: {
      ...process.env,
      // NODE_ENV is what tells the agent it is serving rather than being developed (see above).
      NODE_ENV: "production",
      EVE_NEXT_PRODUCTION_PORT: agentPort,
    },
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
    console.error(`[bot] The console exited (${signal ?? code}); stopping.`);
    stop(code ?? 1);
  });
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => stop(0, signal));
