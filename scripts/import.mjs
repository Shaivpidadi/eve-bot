#!/usr/bin/env node
/**
 * `npm run import`: bring an exported workspace into this deployment's store.
 *
 *   npm run import -- --in workspace.bot.gz --dry-run
 *   npm run import -- --in workspace.bot.gz [--on-conflict replace|skip|fail]
 *
 * Runs only while the server is stopped on a local store (it writes the same
 * files the server holds open). Live runs do not move: an open job's lease is
 * dropped and its thread says so, and the watchdog picks it up, continuing
 * from its journal. Each room starts a fresh session, keeping its history.
 */
import { createReadStream } from "node:fs";

import nextEnv from "@next/env";

nextEnv.loadEnvConfig(process.cwd(), false);

const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? undefined : args[at + 1];
};
const input = flag("in");
const onConflict = flag("on-conflict") ?? "replace";
const dryRun = args.includes("--dry-run");
if (!input || !["replace", "skip", "fail"].includes(onConflict)) {
  console.error("Usage: npm run import -- --in <file> [--dry-run] [--on-conflict replace|skip|fail]");
  process.exit(2);
}

const { store } = await import("../agent/lib/store/index.ts");
const { importFrom } = await import("../agent/lib/store/transfer.ts");
const { record } = await import("../agent/lib/activity.ts");
const { version } = (await import("../package.json", { with: { type: "json" } })).default;

const kv = store();
const outcome = await importFrom(kv, createReadStream(input), { onConflict, dryRun });
const { manifest } = outcome;
if (manifest.version !== version) {
  console.warn(`Note: exported from version ${manifest.version}, importing into ${version}. Older records are read as they are and upgraded when next written.`);
}
if (!dryRun) {
  for (const job of outcome.movedJobs) {
    await record({
      workspaceId: job.workspaceId,
      kind: "job.moved",
      botId: job.botId,
      jobId: job.jobId,
      text: `"${job.title}" moved here from ${manifest.from} while it was running; it will be picked up again and continue from its journal.`,
    });
  }
}
console.log(
  `${dryRun ? "Would write" : "Wrote"} ${outcome.written} keys into ${kv.name}${outcome.skipped > 0 ? `, skipped ${outcome.skipped}` : ""}.` +
    `\n${outcome.movedJobs.length} open job(s) will be re-dispatched; ${outcome.rooms} room(s) start a fresh session.`,
);
