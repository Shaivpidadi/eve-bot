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
 */
import nextEnv from "@next/env";

nextEnv.loadEnvConfig(process.cwd(), false);

const { listJobs } = await import("../agent/lib/jobs.ts");
const { recentActivity } = await import("../agent/lib/activity.ts");
const { formatSummary, summarise } = await import("../agent/lib/metrics.ts");

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

const summary = summarise(jobs, events);
console.log(formatSummary(summary, `${workspace}${days > 0 ? ` · last ${days} days` : ""}`));

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

console.log(
  "\nCost per job is not here: nothing records what a job's model steps cost." +
    "\nRun this before and after a change, on the same kind of work, and compare the rates.",
);
