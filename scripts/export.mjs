#!/usr/bin/env node
/**
 * `npm run export`: take a workspace out of this deployment's store.
 *
 *   npm run export -- --out workspace.bot.gz
 *   npm run export -- --out ws.gz --workspace default --no-secrets
 *
 * Reads the same environment the server does (.env, .env.local, or a pulled
 * Vercel env), so on a Vercel-linked checkout it reads Vercel Blob. What it
 * writes is gzipped NDJSON (see agent/lib/store/transfer.ts). Connector keys
 * and OAuth tokens are included sealed, with the computer access key they are
 * sealed with, so treat the file like a password. --no-secrets leaves all
 * three out; connectors then need reconnecting after the import.
 */
import { createWriteStream } from "node:fs";

import nextEnv from "@next/env";

nextEnv.loadEnvConfig(process.cwd(), false);

const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? undefined : args[at + 1];
};
const out = flag("out");
if (!out) {
  console.error("Usage: npm run export -- --out <file> [--workspace <id>] [--no-secrets]");
  process.exit(2);
}

const { store } = await import("../agent/lib/store/index.ts");
const { exportTo } = await import("../agent/lib/store/transfer.ts");
const { version } = (await import("../package.json", { with: { type: "json" } })).default;

const kv = store();
const manifest = await exportTo(kv, createWriteStream(out), {
  workspace: flag("workspace") ?? null,
  secrets: !args.includes("--no-secrets"),
  version,
});
console.log(
  `Exported ${manifest.counts.docs} documents and ${manifest.counts.bytes} binary objects from ${manifest.from}` +
    `${manifest.workspace ? ` (workspace ${manifest.workspace})` : ""}${manifest.secrets ? "" : ", without secrets"} to ${out}.`,
);
