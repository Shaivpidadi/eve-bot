/** Everything Bot persists. One file so the shape of the product is readable in one place. */

export type BotStatus = "active" | "paused";

export interface Bot {
  readonly id: string;
  readonly workspaceId: string;
  name: string;
  /** One line the operator reads in a roster: "Handles inbound sales follow-up". */
  role: string;
  emoji: string;
  /** The teammate's standing instructions — its personality and its rules. */
  persona: string;
  /** Named capabilities the operator expects: "browser", "email", "research". */
  skills: string[];
  /**
   * Durable lessons the bot has learned about how this team likes things done.
   * Appended by the `learn` tool, replayed into every brief.
   */
  playbook: string[];
  status: BotStatus;
  hiredBy: string;
  hiredAt: string;
  updatedAt: string;
  stats: {
    jobsCompleted: number;
    jobsFailed: number;
  };
}

export type JobStatus =
  | "scheduled"
  | "queued"
  | "dispatched"
  | "running"
  | "blocked"
  | "done"
  | "failed"
  | "cancelled";

export interface JobArtifact {
  readonly id: string;
  readonly name: string;
  readonly mediaType: string;
  readonly bytes: number;
  readonly key: string;
  readonly savedAt: string;
}

export interface Job {
  readonly id: string;
  readonly workspaceId: string;
  readonly botId: string;
  title: string;
  /** What the operator actually asked for, verbatim. */
  brief: string;
  /** What "finished" means, so the bot can check its own work. */
  successCriteria: string[];
  status: JobStatus;
  priority: "normal" | "high";
  /** When the job becomes eligible to run. */
  runAt: string;
  /** Repeat interval in minutes, or `null` for a one-shot job. */
  everyMinutes: number | null;
  /** Require a human to sign off on the deliverable before the job closes. */
  requiresSignoff: boolean;
  /** Address the result should be reported back to. */
  room: string;
  requestedBy: string;
  createdAt: string;
  updatedAt: string;
  attempts: number;
  /**
   * Held while something owns this job, so overlapping ticks cannot double-run
   * it. A `dispatch` lease is the minute-tick saying "I handed this to HQ"; a
   * `run` lease is a bot actually working. A run may take over a dispatch lease,
   * never the other way round.
   */
  lease: { token: string; until: string; kind: "dispatch" | "run" } | null;
  sessionId: string | null;
  agentId: string | null;
  result: JobResult | null;
  error: string | null;
  artifacts: JobArtifact[];
  lastRunAt: string | null;
}

export interface JobResult {
  readonly summary: string;
  readonly deliverable: string;
  readonly openQuestions: string[];
  readonly needsHuman: boolean;
}

export type ActivityKind =
  | "bot.hired"
  | "bot.updated"
  | "bot.retired"
  | "job.assigned"
  | "job.started"
  | "job.progress"
  | "job.artifact"
  | "job.blocked"
  | "job.done"
  | "job.failed"
  | "job.cancelled"
  | "job.learned";

export interface ActivityEvent {
  readonly id: string;
  readonly workspaceId: string;
  readonly at: string;
  readonly kind: ActivityKind;
  readonly botId: string | null;
  readonly jobId: string | null;
  readonly text: string;
  readonly data?: Record<string, unknown>;
}
