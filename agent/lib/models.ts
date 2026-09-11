/**
 * Which model does a job.
 *
 * HQ rates each job's effort when it assigns it, and the teammate running the
 * job picks its model from that rating. Most work does not need the most
 * capable model, and browser work is expensive on one: every step re-sends the
 * page. A job that fails is re-run one level up (see `run_job`).
 *
 * The defaults are models the AI Gateway catalog lists as neither retaining nor
 * training on data, since Bots read inboxes and documents. Override a level
 * with `BOT_MODEL_QUICK`, `BOT_MODEL_STANDARD`, or `BOT_MODEL_DEEP`;
 * `BOT_TEAMMATE_MODEL` pins one model for every level.
 */
export const JOB_EFFORTS = ["quick", "standard", "deep"] as const;
export type JobEffort = (typeof JOB_EFFORTS)[number];

export const DEFAULT_EFFORT: JobEffort = "standard";

const DEFAULT_MODELS: Readonly<Record<JobEffort, string>> = {
  // $0.16 / $0.47 per million tokens: lookups, status checks, routine monitors.
  quick: "alibaba/qwen3.8-flash",
  // $2 / $10: most work, from browsing apps to reading and drafting.
  standard: "anthropic/claude-sonnet-5",
  // $5 / $25: hard multi-step research, analysis, coding, anything high-stakes.
  deep: "anthropic/claude-opus-5",
};

const MODEL_ENV: Readonly<Record<JobEffort, string>> = {
  quick: "BOT_MODEL_QUICK",
  standard: "BOT_MODEL_STANDARD",
  deep: "BOT_MODEL_DEEP",
};

export const isJobEffort = (value: unknown): value is JobEffort =>
  typeof value === "string" && (JOB_EFFORTS as readonly string[]).includes(value);

export function modelForEffort(effort: JobEffort): string {
  const pinned = process.env.BOT_TEAMMATE_MODEL?.trim();
  if (pinned) return pinned;
  return process.env[MODEL_ENV[effort]]?.trim() || DEFAULT_MODELS[effort];
}

/** One level up, for a job whose last run failed. */
export function nextEffort(effort: JobEffort): JobEffort {
  return effort === "quick" ? "standard" : "deep";
}

const EFFORT_LINE = /^effort: (quick|standard|deep)$/m;

/** The brief states the job's effort on its own line (see `renderBrief`). */
export function effortInBrief(brief: string): JobEffort {
  const match = EFFORT_LINE.exec(brief)?.[1];
  return isJobEffort(match) ? match : DEFAULT_EFFORT;
}

export const REASONING_LEVELS = ["low", "medium", "high", "xhigh"] as const;
export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

export function reasoningLevel(value: string | undefined, fallback: ReasoningLevel): ReasoningLevel {
  return REASONING_LEVELS.find((level) => level === value) ?? fallback;
}
