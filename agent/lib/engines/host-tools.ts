/**
 * The eve-bot tools a Claude Code Bot gets: the only tools it has (no
 * built-ins, plan section 4.3), served by durable-harness as an MCP server in
 * the Function, never in the Sandbox.
 *
 * The three a job cannot do without (read the job, log a step, record the
 * result); `send_email`, which never sends: it asks a person, and eve-bot
 * sends it once they approve (`./proposals`); and the team's connectors
 * (`./connector-calls`): list them, read through them, and change something
 * through them, which asks a person wherever the connector's gate would ask
 * for an eve Bot. Each one is fenced the way the teammate's
 * are: the session is the job's run only while the job's lease names it
 * (`run_job` binds the two when it starts the session), so a session that
 * was cancelled, or outlived its lease, writes nothing.
 *
 * Which job and workspace a session works for comes from the session's own
 * config, written by `run_job` when it started the session, never from the
 * model: a model cannot point these tools at another job.
 *
 * Replay, as durable-harness asks every tool to declare it: `job_brief`,
 * `log_progress`, `connector_tools` and `connector_read` are safe to run
 * twice (a repeated journal line is dropped by `appended`; a read changes
 * nothing), `finish_job`, `send_email` and `connector_change` run at most once
 * (and a second ask for the same action in the run is the same proposal
 * anyway).
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

const EmailInput = z.object({
  to: z.array(z.string().max(200)).min(1).max(20),
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(20_000),
  cc: z.array(z.string().max(200)).max(20).optional(),
});

export const sendEmail: HarnessTool = {
  name: "send_email",
  label: "Ask to send an email",
  description:
    "Ask a person to send an email on the operator's behalf. It is never sent by this call: the person sees it exactly as written and approves or declines it, and eve-bot sends it once they approve. Call it once per email, then carry on; you hear back when they decide.",
  inputSchema: schema(EmailInput),
  replay: "never",
  async execute(input, io) {
    const config = sessionConfigOf(io.ctx.config);
    if (config === null) return NotBound;
    const parsed = EmailInput.safeParse(input);
    if (!parsed.success) return answer({ ok: false, message: parsed.error.issues.map((issue) => issue.message).join("; ") });
    const check = await checkRun(config.workspaceId, config.jobId, io.ctx.runId);
    if (!check.ok) return answer({ ok: false, message: describeRunRefusal(check.reason, config.jobId) });
    const job = check.job;
    const email = parsed.data;
    const payload = { to: email.to, cc: email.cc ?? [], subject: email.subject, text: email.body, jobId: job.id };
    const { effectiveEnv } = await import("../settings/store");
    if (!(await effectiveEnv()).BOT_EMAIL_WEBHOOK?.trim()) {
      return answer({
        ok: false,
        status: "draft",
        message:
          "No email webhook is set (Settings, Email), so it cannot be sent. Put the draft in your result and say it is unsent; do not send it any other way.",
      });
    }
    const { proposeEmail } = await import("./proposals");
    const proposed = await proposeEmail({
      workspaceId: config.workspaceId,
      jobId: job.id,
      botId: job.botId,
      runToken: job.lease?.token ?? io.ctx.runId,
      sessionId: io.ctx.runId,
      requester: job.requestedBy,
      payload,
    });
    if (proposed.decided !== null) {
      return answer({ ok: true, status: proposed.decided.outcome, message: `A person already ${proposed.decided.outcome === "approved" ? "approved" : "declined"} this exact email. Do not send it again.` });
    }
    return answer({
      ok: true,
      status: "awaiting_approval",
      actionId: proposed.actionId,
      message:
        "A person was asked. If they approve, eve-bot sends it exactly as written. Do not call send_email again for it, and never send it any other way. Carry on; if you finish first, say in your result that it is waiting for approval.",
    });
  },
};

const ConnectorToolsInput = z.object({
  connector: z.string().max(80).optional().describe("A connector's name, for its tools' descriptions and inputs. Leave it out to list the connectors."),
});

const ConnectorCallInput = z.object({
  connector: z.string().min(1).max(80).describe("The connector's name, from connector_tools."),
  tool: z.string().min(1).max(120).describe("The tool's name, from connector_tools."),
  arguments: z.record(z.string(), z.unknown()).describe("The tool's input, as its inputSchema says."),
});

/** The run check every connector tool makes first, and the job it is for. */
async function connectorRun(io: HarnessToolIO) {
  const config = sessionConfigOf(io.ctx.config);
  if (config === null) return { ok: false as const, message: NotBound };
  const check = await checkRun(config.workspaceId, config.jobId, io.ctx.runId);
  if (!check.ok) return { ok: false as const, message: answer({ ok: false, message: describeRunRefusal(check.reason, config.jobId) }) };
  return { ok: true as const, workspaceId: config.workspaceId, job: check.job };
}

export const connectorTools: HarnessTool = {
  name: "connector_tools",
  label: "See the connectors",
  description:
    "List the team's connectors (apps such as an issue tracker or a calendar) and the tools you may use on each, whether each one reads or changes something, and when a person is asked. Name a connector to get its tools' descriptions and input schemas.",
  inputSchema: schema(ConnectorToolsInput),
  replay: "safe",
  async execute(input, io) {
    const run = await connectorRun(io);
    if (!run.ok) return run.message;
    const parsed = ConnectorToolsInput.safeParse(input);
    if (!parsed.success) return answer({ ok: false, message: parsed.error.issues.map((issue) => issue.message).join("; ") });
    const calls = await import("./connector-calls");
    if (parsed.data.connector === undefined) {
      const connectors = await calls.connectorsFor(run.workspaceId);
      return answer({ ok: true, connectors, ...(connectors.length === 0 ? { message: "No connectors are set up for this team." } : {}) });
    }
    const live = await calls.findConnector(run.workspaceId, parsed.data.connector);
    if (live === null || !live.enabled) return answer({ ok: false, message: `No connector "${parsed.data.connector}" is on. Call connector_tools with no connector to list them.` });
    try {
      return answer({ ok: true, connector: live.name, tools: await calls.toolsOf(live) });
    } catch (error) {
      return answer({ ok: false, message: `${live.label} did not answer: ${error instanceof Error ? error.message : String(error)}` });
    }
  },
};

export const connectorRead: HarnessTool = {
  name: "connector_read",
  label: "Read through a connector",
  description:
    "Call a connector tool that only reads (its effect is \"read\" in connector_tools), and get its answer. For anything that changes something, or on a connector that asks before every call, use connector_change.",
  inputSchema: schema(ConnectorCallInput),
  replay: "safe",
  async execute(input, io) {
    const run = await connectorRun(io);
    if (!run.ok) return run.message;
    const parsed = ConnectorCallInput.safeParse(input);
    if (!parsed.success) return answer({ ok: false, message: parsed.error.issues.map((issue) => issue.message).join("; ") });
    const calls = await import("./connector-calls");
    const live = await calls.findConnector(run.workspaceId, parsed.data.connector);
    const decision = calls.decide(live, parsed.data.tool);
    if (decision.kind === "refuse") return answer({ ok: false, message: decision.reason });
    if (decision.kind === "ask" || decision.effect !== "read") {
      return answer({ ok: false, message: `${parsed.data.tool} is not a read this connector runs unasked. Use connector_change; a person is asked when the connector says so.` });
    }
    try {
      const result = await calls.callTool(live!, parsed.data.tool, parsed.data.arguments);
      return answer({ ok: !result.isError, result: result.text });
    } catch (error) {
      return answer({ ok: false, message: `${live!.label} did not answer: ${error instanceof Error ? error.message : String(error)}` });
    }
  },
};

export const connectorChange: HarnessTool = {
  name: "connector_change",
  label: "Change something through a connector",
  description:
    "Call a connector tool that changes something (or any tool on a connector that asks before every call). Where the connector asks a person first, this never calls it: the person sees the exact call and approves or declines, and eve-bot makes it once they approve; you hear back with its answer. Otherwise it is called now. Call it once per change.",
  inputSchema: schema(ConnectorCallInput),
  replay: "never",
  async execute(input, io) {
    const run = await connectorRun(io);
    if (!run.ok) return run.message;
    const parsed = ConnectorCallInput.safeParse(input);
    if (!parsed.success) return answer({ ok: false, message: parsed.error.issues.map((issue) => issue.message).join("; ") });
    const calls = await import("./connector-calls");
    const live = await calls.findConnector(run.workspaceId, parsed.data.connector);
    const decision = calls.decide(live, parsed.data.tool);
    if (decision.kind === "refuse" || live === null) return answer({ ok: false, message: decision.kind === "refuse" ? decision.reason : "No such connector." });
    if (decision.kind === "go") {
      // The connector asks nobody: called now, and this tool never runs twice.
      try {
        const result = await calls.callTool(live, parsed.data.tool, parsed.data.arguments);
        await record({ workspaceId: run.workspaceId, kind: "job.progress", botId: run.job.botId, jobId: run.job.id, text: `Ran ${live.label} ${parsed.data.tool}.` });
        return answer({ ok: !result.isError, status: result.isError ? "failed" : "done", result: result.text });
      } catch (error) {
        return answer({ ok: false, status: "unknown", message: `${live.label} gave no clear answer, so it may or may not have run: ${error instanceof Error ? error.message : String(error)}. Check before trying again.` });
      }
    }
    const { permissionVersion } = await import("../connectors");
    const { proposeConnectorCall } = await import("./proposals");
    const proposed = await proposeConnectorCall({
      workspaceId: run.workspaceId,
      jobId: run.job.id,
      botId: run.job.botId,
      runToken: run.job.lease?.token ?? io.ctx.runId,
      sessionId: io.ctx.runId,
      requester: run.job.requestedBy,
      payload: { connectorId: live.id, connector: live.name, label: live.label, tool: parsed.data.tool, arguments: parsed.data.arguments, jobId: run.job.id },
      permissionVersion: permissionVersion(live),
    });
    if (proposed.decided !== null) {
      return answer({ ok: true, status: proposed.decided.outcome, message: `A person already ${proposed.decided.outcome === "approved" ? "approved" : "declined"} this exact call. Do not ask for it again.` });
    }
    return answer({
      ok: true,
      status: "awaiting_approval",
      actionId: proposed.actionId,
      message:
        "A person was asked. If they approve, eve-bot makes this call exactly as written and you hear its answer. Do not ask for it again, and never make it any other way. Carry on; if you finish first, say in your result that it is waiting for approval.",
    });
  },
};

/** Every tool a Claude Code or Codex Bot has. */
export const HOST_TOOLS: readonly HarnessTool[] = [jobBrief, logProgress, finishJob, sendEmail, connectorTools, connectorRead, connectorChange];
