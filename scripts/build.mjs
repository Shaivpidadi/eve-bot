#!/usr/bin/env node
/**
 * `npm run build`: the console and the agent, for wherever this copy of Bot runs.
 *
 * On Vercel, `withEve` builds the agent as its own service, so only Next.js
 * builds here. Anywhere else, `next start` serves the agent from `.output/`,
 * which `eve build` writes first.
 */
import { spawnSync } from "node:child_process";

import nextEnv from "@next/env";

import { overlaySettings, savedSettings } from "./settings.mjs";

// eve build does not read .env on its own, and the agent decides a few things
// (which web_search, which model endpoint) when its modules load, so the build
// must see the same environment the server will. Next.js loads .env itself.
if (!process.env.VERCEL) nextEnv.loadEnvConfig(process.cwd(), false);

// Caps and the computer's backend saved in Settings win over the environment's,
// as they do everywhere else; eve fixes them in what it builds.
overlaySettings(savedSettings("plan")?.overlay);

// Since eve 0.79, `eve build` prepares the computer's sandbox (a Vercel snapshot,
// a Docker image) and a production server will not build a missing one, so a
// build you deploy keeps that step. BOT_SKIP_SANDBOX_PREWARM=1 skips it where the
// build only checks the code, such as CI with no Vercel credentials.
const eveBuild = process.env.BOT_SKIP_SANDBOX_PREWARM === "1" ? ["eve", "build", "--skip-sandbox-prewarm"] : ["eve", "build"];
const steps = process.env.VERCEL ? [["next", "build"]] : [eveBuild, ["next", "build"]];

for (const [bin, ...args] of steps) {
  const result = spawnSync(bin, args, { stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// So the running agent, and the Settings page, know what this build used.
savedSettings("record");
