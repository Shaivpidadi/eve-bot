/** Everything Bot persists. One file so the shape of the product is readable in one place. */

import type { JobEffort } from "./models";

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
  /** The Bot that created this one at the operator's request, when a Bot did. */
  createdBy?: { readonly botId: string; readonly name: string } | null;
  /** Roster placement, set from the console's row menu. Absent on older Bots. */
  pinned?: boolean;
  /** A named group in the roster, or null for none. */
  section?: string | null;
  /** Kept off the roster until unhidden; still on the team. */
  hidden?: boolean;
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

export type JobLeaseKind = "dispatch" | "run" | "signoff" | "wait";

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
  /** How hard the job is, which picks the teammate's model (see `models.ts`). Absent on older jobs. */
  effort?: JobEffort;
  /** Who set the effort: HQ in its brief, or the default. Absent on older jobs. */
  effortBy?: "hq" | "default";
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
   * Held while something owns this job, so nothing double-runs it. A `wait`
   * lease is a run sleeping until the job's start time; a `dispatch` lease is
   * the watchdog saying "I handed this to HQ"; a `run` lease is a bot actually
   * working, renewed while it works; a `signoff` lease is a finished run
   * waiting on a person. A run may take over a dispatch lease, and its own or
   * (when started early on purpose) another run's wait lease, never the other
   * way round.
   */
  lease: { token: string; until: string; kind: JobLeaseKind } | null;
  sessionId: string | null;
  agentId: string | null;
  result: JobResult | null;
  /** The operator's note when they last sent the work back; cleared once the job closes. Absent on older jobs. */
  feedback?: string | null;
  error: string | null;
  artifacts: JobArtifact[];
  lastRunAt: string | null;
}

/**
 * How far a bot got to proving its own result, so "done" cannot hide how much
 * of it to trust.
 *
 * - `verified`: the bot re-checked the outcome after acting.
 * - `recorded`: the bot closed the job with `finish_job` but did not re-check.
 * - `recovered`: the bot never closed the job, and the result was assembled
 *   from what the run left behind (see `run_job`).
 *
 * Absent on results recorded before this was kept.
 */
export type JobCompletion = "verified" | "recorded" | "recovered";

export interface JobResult {
  readonly summary: string;
  readonly deliverable: string;
  readonly openQuestions: string[];
  readonly needsHuman: boolean;
  /** How the result came to be. Absent on older results. */
  readonly completion?: JobCompletion;
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
  | "job.learned"
  | "input.requested"
  | "computer.restored"
  | "computer.failed"
  | "computer.takeover"
  | "computer.handback";

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
