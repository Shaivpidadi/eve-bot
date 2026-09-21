#!/usr/bin/env node
/**
 * `npm run jev:report`: what Jev would have decided, against what happened.
 *
 * Every Jev judgement runs in shadow first (see `agent/lib/jev-watch.ts`).
 * This reads those records back so the question "should this be allowed to
 * decide anything?" is answered with this deployment's own jobs rather than
 * with a hunch.
 */
import nextEnv from "@next/env";

nextEnv.loadEnvConfig(process.cwd(), false);

const { listShadow } = await import("../agent/lib/jev-watch.ts");

const workspace = process.argv[2] ?? process.env.BOT_WORKSPACE ?? "default";
const entries = await listShadow(workspace);

if (entries.length === 0) {
  console.log(`No Jev observations for workspace "${workspace}" yet.`);
  console.log("Jev runs only with an AI Gateway key (AI_GATEWAY_API_KEY) and BOT_JEV unset or on.");
  process.exit(0);
}

const byKind = new Map();
for (const entry of entries) {
  const bucket = byKind.get(entry.kind) ?? [];
  bucket.push(entry);
  byKind.set(entry.kind, bucket);
}

console.log(`Jev observations for "${workspace}": ${entries.length} (${entries[0].at} … ${entries[entries.length - 1].at})\n`);

for (const [kind, bucket] of byKind) {
  console.log(`## ${kind} (${bucket.length})`);
  const counts = new Map();
  for (const entry of bucket) {
    const key = `${entry.verdict} · closed as ${entry.actual}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const [key, n] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${key}`);

  const confident = bucket.filter((entry) => typeof entry.confidence === "number");
  if (confident.length > 0) {
    const mean = confident.reduce((total, entry) => total + entry.confidence, 0) / confident.length;
    console.log(`  mean confidence ${mean.toFixed(2)}`);
  }

  if (kind === "completion") {
    const disagreed = bucket.filter((entry) => entry.verdict === "no");
    console.log(`  jobs Jev would not have called finished: ${disagreed.length}`);
    for (const entry of disagreed.slice(0, 10)) {
      console.log(`    ${entry.jobId} (${entry.actual}, ${entry.detail?.unmetCriteria?.length ?? 0} unmet)`);
    }
  }
  console.log();
}
