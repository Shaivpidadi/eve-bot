#!/usr/bin/env node
/**
 * `npm run build`: the console and the agent, for wherever this copy of Bot runs.
 *
 * On Vercel, `withEve` builds the agent as its own service, so only Next.js
 * builds here. Anywhere else, `next start` serves the agent from `.output/`,
 * which `eve build` writes first.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import nextEnv from "@next/env";

import { overlaySettings, savedSettings } from "./settings.mjs";

// eve build does not read .env on its own, and the agent decides a few things
// (which web_search, which model endpoint) when its modules load, so the build
// must see the same environment the server will. Next.js loads .env itself.
if (!process.env.VERCEL) nextEnv.loadEnvConfig(process.cwd(), false);

// Caps, the computer's backend and the engines saved in Settings win over the
// environment's, as they do everywhere else; eve fixes them in what it builds.
const overlay = savedSettings("plan")?.overlay ?? {};
overlaySettings(overlay);

// A deployment's functions never see this process's environment, so the same
// values go into the build itself (agent/lib/settings/built.ts lays them over
// the server's environment when it loads). Put back as it was afterwards.
const BUILT = "agent/lib/settings/built.ts";
const pristine = readFileSync(BUILT, "utf8");
const restore = () => writeFileSync(BUILT, pristine);
if (Object.keys(overlay).length > 0) {
  const filled = pristine.replace(/const BUILT: Readonly<Record<string, string>> = \{\};/, `const BUILT: Readonly<Record<string, string>> = ${JSON.stringify(overlay)};`);
  if (filled === pristine) {
    console.error(`[bot] ${BUILT} no longer has the line the build fills in; the saved settings would not reach the server.`);
    process.exit(1);
  }
  writeFileSync(BUILT, filled);
}

// Since eve 0.79, `eve build` prepares the computer's sandbox (a Vercel snapshot,
// a Docker image) and a production server will not build a missing one, so a
// build you deploy keeps that step. BOT_SKIP_SANDBOX_PREWARM=1 skips it where the
// build only checks the code, such as CI with no Vercel credentials.
// Each tool's own entry, run by this Node: found whether or not npm put node_modules/.bin on the
// PATH (npm start runs this script directly), and with no shell on Windows, where .bin holds .cmd files.
const eve = join(process.cwd(), "node_modules", "eve", "bin", "eve.js");
const next = join(process.cwd(), "node_modules", "next", "dist", "bin", "next");
const eveBuild = process.env.BOT_SKIP_SANDBOX_PREWARM === "1" ? [eve, "build", "--skip-sandbox-prewarm"] : [eve, "build"];
const steps = process.env.VERCEL ? [[next, "build"]] : [eveBuild, [next, "build"]];

for (const args of steps) {
  const result = spawnSync(process.execPath, args, { stdio: "inherit" });
  if (result.status !== 0) {
    restore();
    process.exit(result.status ?? 1);
  }
}
restore();

// So the running agent, and the Settings page, know what this build used.
savedSettings("record");
