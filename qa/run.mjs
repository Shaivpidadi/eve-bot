#!/usr/bin/env node
/**
 * `npm run qa`: drive a running deployment and assert what must hold.
 *
 *   QA_URL=https://staging.example QA_TOKEN=… npm run qa
 *
 * Checks that cost model tokens (a real job, a real routine) are off unless
 * QA_JOBS=1, so the default run is free and fast enough to sit in front of a
 * deploy. Evidence for anything that fails is written under .qa/.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { client, runChecks } from "./harness.mjs";
import access from "./checks/access.mjs";
import roster from "./checks/roster.mjs";
import memory from "./checks/memory.mjs";
import connectors from "./checks/connectors.mjs";
import jobs from "./checks/jobs.mjs";

const url = process.env.QA_URL?.trim();
const token = process.env.QA_TOKEN?.trim();

if (!url || !token) {
  console.error("QA_URL and QA_TOKEN are required.\n");
  console.error("  QA_URL=http://localhost:3000 QA_TOKEN=$BOT_CONSOLE_TOKEN npm run qa\n");
  console.error("Point it at a deployment you are willing to have a bot poke at:");
  console.error("it hires bots, writes memory, and (with QA_JOBS=1) runs jobs.");
  process.exit(2);
}

const withJobs = process.env.QA_JOBS === "1";
const concurrency = Number(process.env.QA_CONCURRENCY) || 3;
const checks = [...access, ...roster, ...memory, ...connectors, ...(withJobs ? jobs : [])];

console.log(`Bot QA · ${url} · ${checks.length} checks · ${concurrency} at a time${withJobs ? " · jobs included" : ""}\n`);

const results = await runChecks(checks, { call: client({ url, token }), url, withJobs }, {
  concurrency,
  onResult: (result) => {
    const mark = result.skipped ? "○" : result.ok ? "✓" : "✗";
    const detail = result.skipped
      ? ` · skipped: ${result.skipped}`
      : result.ok
        ? result.detail
          ? ` · ${result.detail}`
          : ""
        : ` · ${result.error}`;
    console.log(`  ${mark} ${result.name} (${result.ms}ms)${detail}`);
  },
});

const failed = results.filter((result) => !result.ok);
const skipped = results.filter((result) => result.skipped);
console.log(
  `\n${results.length - failed.length - skipped.length}/${results.length} passed` +
    (skipped.length > 0 ? `, ${skipped.length} skipped` : ""),
);

if (failed.length > 0) {
  const dir = join(".qa", new Date().toISOString().replace(/[:.]/g, "-"));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "failures.json"), `${JSON.stringify({ url, at: new Date().toISOString(), failed }, null, 2)}\n`);
  console.log(`\nEvidence for the failures: ${join(dir, "failures.json")}`);
  console.log("Each entry has the check, what it expected, and what the deployment actually answered.");
  process.exit(1);
}
