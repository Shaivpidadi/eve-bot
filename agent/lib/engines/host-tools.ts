/**
 * The eve-bot tools a Claude Code Bot gets: the only tools it has (no
 * built-ins, plan section 4.3), served by durable-harness as an MCP server in
 * the Function, never in the Sandbox.
 *
 * Phase 1 is three tools, the ones a job cannot do without: read the job,
 * log a step, record the result. Each one is fenced the way the teammate's
 * are: the session is the job's run only while the job's lease names it
 * (`run_job` binds the two when it starts the session), so a session that
 * was cancelled, or outlived its lease, writes nothing.
 *
 * Which job and workspace a session works for comes from the session's own
 * config, written by `run_job` when it started the session, never from the
 * model: a model cannot point these tools at another job.
 *
 * Replay, as durable-harness asks every tool to declare it: `job_brief` and
 * `log_progress` are safe to run twice (a repeated journal line is dropped by
 * `appended`), `finish_job` runs at most once.
 *
 * Nothing here imports durable-harness: these are plain objects in its
 * `HostTool` shape, so they load (and are tested) without it.
 */
import { z } from "zod";

import { record, recentActivity } from "../activity";
import { getBot } from "../bots";
import { checkRun, describeRunRefusal, appendJournal, patchJobAsRun } from "../jobs";
import type { JobResult } from "../types";

/** What `run_job` writes into a harness session's config. No secrets: the config is in the session's log. */
export interface HarnessSessionConfig {
  readonly workspaceId: string;
  readonly jobId: string;
}

export function sessionConfigOf(config: unknown): HarnessSessionConfig | null {
  if (typeof config !== "object" || config === null) return null;
  const { workspaceId, jobId } = config as Record<string, unknown>;
  return typeof workspaceId === "string" && workspaceId !== "" && typeof jobId === "string" && jobId !== "" ? { workspaceId, jobId } : null;
}

/** The slice of durable-harness's `HostToolIO` these tools read. */
export interface HarnessToolIO {
  readonly ctx: { readonly runId: string; readonly config: unknown };
}

/** durable-harness's `HostTool`, structurally. */
export interface HarnessTool {
  readonly name: string;
  readonly label?: string;
  readonly description: string;
  readonly inputSchema: object;
  readonly replay: "safe" | "never";
  execute(input: unknown, io: HarnessToolIO): Promise<string>;
}

const answer = (value: unknown): string => JSON.stringify(value);

const NotBound = answer({ ok: false, message: "This session is not running a job. Stop and end your turn." });

const LogInput = z.object({
  note: z.string().min(3).max(400).describe("One line: what you did and what came of it, or for a decision, what you chose and why."),
  kind: z.enum(["progress", "decision"]).optional().describe('"decision" for a change of plan or a step skipped on purpose; "progress" (the default) for everything else.'),
});

const FinishInput = z.object({
  summary: z.string().min(5).max(600).describe("What happened, for a busy person."),
  deliverable: z.string().min(1).max(8_000).describe("The output itself, or exactly where it now lives."),
  openQuestions: z.array(z.string().max(300)).max(10).optional(),
  needsHuman: z.boolean().describe("True only when the job cannot count as done until a person acts. Open questions alone are not a reason."),
  verified: z.boolean().describe("True only if you re-checked the result after acting, rather than assuming it."),
});

const schema = (shape: z.ZodType): object => {
  const { $schema: _drop, ...rest } = z.toJSONSchema(shape) as Record<string, unknown>;
  return rest;
};

export const jobBrief: HarnessTool = {
  name: "job_brief",
  label: "Read the job",
  description:
    "Read the job you were given: the brief, the success criteria, your persona and playbook, and what has already been logged. Call this first.",
  inputSchema: schema(z.object({})),
  replay: "safe",
  async execute(_input, io) {
    const config = sessionConfigOf(io.ctx.config);
    if (config === null) return NotBound;
    const check = await checkRun(config.workspaceId, config.jobId, io.ctx.runId);
    if (!check.ok) return answer({ ok: false, message: describeRunRefusal(check.reason, config.jobId) });
    const job = check.job;
    const [bot, timeline] = await Promise.all([
      getBot(config.workspaceId, job.botId),
      recentActivity(config.workspaceId, { jobId: job.id, limit: 30 }),
    ]);
    return answer({
      ok: true,
      job: {
        id: job.id,
        title: job.title,
        brief: job.brief,
        successCriteria: job.successCriteria,
        requestedBy: job.requestedBy,
        attempts: job.attempts,
        requiresSignoff: job.requiresSignoff,
        previousResult: job.result,
        previousError: job.error,
        feedback: job.feedback ?? null,
      },
      you: bot === null ? null : { name: bot.name, role: bot.role, persona: bot.persona, playbook: bot.playbook },
      alreadyLogged: timeline.map((event) => ({ at: event.at, text: event.text })),
    });
  },
};

export const logProgress: HarnessTool = {
  name: "log_progress",
  label: "Log a step",
  description:
    'Record one meaningful step you just took, in words the person reads later. Use kind "decision" when you change plan or skip a step on purpose, and say why.',
  inputSchema: schema(LogInput),
  replay: "safe",
  async execute(input, io) {
    const config = sessionConfigOf(io.ctx.config);
    if (config === null) return NotBound;
    const parsed = LogInput.safeParse(input);
    if (!parsed.success) return answer({ ok: false, message: parsed.error.issues.map((issue) => issue.message).join("; ") });
    const { note, kind } = parsed.data;
    // Journal first: it is fenced in one write, so a run that lost the job writes nothing at all.
    const written = await appendJournal(config.workspaceId, config.jobId, io.ctx.runId, { kind: kind ?? "progress", text: note });
    if (!written.ok) return answer({ ok: false, message: describeRunRefusal(written.reason, config.jobId) });
    await record({
      workspaceId: config.workspaceId,
      kind: "job.progress",
      jobId: config.jobId,
      botId: written.job.botId,
      text: kind === "decision" ? `Decided: ${note}` : note,
    });
    return answer({ ok: true });
  },
};

export const finishJob: HarnessTool = {
  name: "finish_job",
  label: "Record the result",
  description: "Record the outcome of the job. Call it once, at the end. Status and sign-off are handled for you; your part is an honest result.",
  inputSchema: schema(FinishInput),
  replay: "never",
  async execute(input, io) {
    const config = sessionConfigOf(io.ctx.config);
    if (config === null) return NotBound;
    const parsed = FinishInput.safeParse(input);
    if (!parsed.success) return answer({ ok: false, message: parsed.error.issues.map((issue) => issue.message).join("; ") });
    const fields = parsed.data;
    const draft: JobResult = {
      summary: fields.summary,
      deliverable: fields.deliverable,
      openQuestions: fields.openQuestions ?? [],
      needsHuman: fields.needsHuman,
      completion: fields.verified ? "verified" : "recorded",
      recordedAt: new Date().toISOString(),
    };
    // Only the job's current run may record its result, and the result names that run.
    const written = await patchJobAsRun(config.workspaceId, config.jobId, io.ctx.runId, (current, run) => ({
      ...current,
      result: { ...draft, producedBy: run },
    }));
    if (!written.ok) return answer({ ok: false, recorded: false, message: describeRunRefusal(written.reason, config.jobId) });
    await record({
      workspaceId: config.workspaceId,
      kind: "job.progress",
      botId: written.job.botId,
      jobId: config.jobId,
      text: `Result recorded (${fields.verified ? "verified" : "unverified"}): ${fields.summary}`,
    });
    return answer({ ok: true, recorded: true, next: "The result is recorded. End your turn now." });
  },
};

/** Every tool a Claude Code Bot has in phase 1. */
export const HOST_TOOLS: readonly HarnessTool[] = [jobBrief, logProgress, finishJob];
