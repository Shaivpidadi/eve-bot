#!/usr/bin/env node
/**
 * `npm run metrics`: how the Bots are actually doing.
 *
 * Reads the jobs and the activity feed this deployment already keeps, and
 * prints the numbers worth comparing before and after a change: how many
 * closes the bots verified, how many were recovered from leftovers, how often
 * a person had to step in, and how long a job takes.
 *
 *   npm run metrics                 # the default workspace
 *   npm run metrics -- --days 7     # only the last week
 *   npm run metrics -- --resume     # how well resumed runs continued (redo ratio)
 */
import nextEnv from "@next/env";

nextEnv.loadEnvConfig(process.cwd(), false);

const { listJobs } = await import("../agent/lib/jobs.ts");
const { recentActivity } = await import("../agent/lib/activity.ts");
const { formatSummary, summarise } = await import("../agent/lib/metrics.ts");
const { redoRatio } = await import("../agent/lib/journal.ts");

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? fallback : args[at + 1];
};

const workspace = flag("workspace", process.env.BOT_WORKSPACE ?? "default");
const days = Number(flag("days", "0"));
const since = days > 0 ? Date.now() - days * 24 * 60 * 60_000 : null;

const allJobs = await listJobs(workspace, { limit: 500 });
const jobs = since === null ? allJobs : allJobs.filter((job) => Date.parse(job.createdAt) >= since);
const events = await recentActivity(workspace, { limit: 2_000 });

if (jobs.length === 0) {
  console.log(`No jobs in workspace "${workspace}"${days > 0 ? ` in the last ${days} days` : ""} yet.`);
  process.exit(0);
}

if (args.includes("--resume")) {
  const resumed = jobs
    .map((job) => ({ job, ratio: redoRatio(job.journal ?? [], job.resumedFrom) }))
    .filter((row) => row.ratio !== null);
  if (resumed.length === 0) {
    console.log("No job has resumed from a journal yet.");
    process.exit(0);
  }
  const mean = resumed.reduce((sum, row) => sum + row.ratio, 0) / resumed.length;
  console.log(`Resumed runs: ${resumed.length} · mean redo ratio ${mean.toFixed(2)} (0 is a clean continuation)\n`);
  for (const { job, ratio } of resumed.sort((a, b) => b.ratio - a.ratio)) {
    console.log(`  ${job.id}  ${ratio.toFixed(2)}  from step ${job.resumedFrom} of ${(job.journal ?? []).length}  ${job.title.slice(0, 60)}`);
  }
  process.exit(0);
}

const summary = summarise(jobs, events);
console.log(formatSummary(summary, `${workspace}${days > 0 ? ` · last ${days} days` : ""}`));

const journaled = jobs.filter((job) => (job.journal ?? []).length > 0);
if (journaled.length > 0) {
  const withDecisions = journaled.filter((job) => job.journal.some((entry) => entry.kind === "decision")).length;
  console.log(`\nJournals: ${journaled.length} job(s) kept one; ${withDecisions} recorded at least one decision (${Math.round((withDecisions / journaled.length) * 100)}%).`);
}

const worst = summary.outcomes
  .filter((outcome) => outcome.completion === "recovered" || outcome.status === "failed" || outcome.needsHuman)
  .slice(0, 10);

if (worst.length > 0) {
  console.log("\nWorth reading:");
  for (const outcome of worst) {
    console.log(
      `  ${outcome.jobId}  ${outcome.status.padEnd(9)} ${outcome.completion.padEnd(9)} ${
        outcome.interventions > 0 ? `${outcome.interventions} interruption(s)` : ""
      } ${outcome.title.slice(0, 60)}`,
    );
  }
}

// What each job's model steps cost, as the job counted them (`job.usage`, see agent/lib/usage.ts).
const priced = jobs.map((job) => job.usage?.costUsd).filter((cost) => typeof cost === "number");
if (priced.length > 0) {
  const sorted = [...priced].sort((a, b) => a - b);
  const total = priced.reduce((sum, cost) => sum + cost, 0);
  const median = sorted.length % 2 === 1 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  console.log(`\nCost: $${total.toFixed(3)} over ${priced.length} job(s) that counted it · median $${median.toFixed(4)} per job.`);
}

console.log("\nRun this before and after a change, on the same kind of work, and compare the rates.");
