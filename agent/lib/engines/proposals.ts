/**
 * Outward actions a Claude Code or Codex Bot asks a person for (plan section
 * 4.3, H2). Such a Bot has no eve approval card, so its `send_email` never
 * sends: it proposes the email in the action ledger (`../actions`), keeps the
 * draft here beside it (the ledger holds only its hash), and asks the person,
 * with a "needs you" push and a card in the Bot's thread.
 *
 * When the person approves, eve-bot sends it itself, once, through the same
 * path an eve Bot's approved email takes (`../email-send`): the model never
 * calls the tool a second time to make it happen, so a model that forgets, or
 * a replayed call, can neither send twice nor skip the send. Approving checks
 * the draft still hashes to what was proposed, and that the job was not
 * cancelled; the ledger refuses an approval past its 24 hours. Denying leaves
 * the ledger's proposal to expire unused.
 *
 * What happened is told to the Bot's session when it is still the job's run,
 * as a follow-up message; otherwise the job's feed says it.
 */
import { getAction, hashArgs, proposeAction } from "../actions";
import { record } from "../activity";
import { type EmailPayload, executeEmail } from "../email-send";
import { getJob } from "../jobs";
import { readDoc, updateDoc, writeDoc } from "../store";
import { engineOf, type HarnessEngine } from "./index";

export interface EmailProposal {
  readonly actionId: string;
  readonly workspaceId: string;
  readonly jobId: string;
  readonly botId: string;
  /** The session that asked, so the answer can be told to it. */
  readonly sessionId: string;
  readonly payload: EmailPayload;
  readonly at: string;
  readonly decided: { readonly outcome: "approved" | "denied"; readonly by: string; readonly at: string; readonly status: string } | null;
}

const proposalKey = (workspaceId: string, actionId: string) => `proposals/${workspaceId}/${actionId}.json`;

/** The `callId` a harness proposal carries in the ledger, telling it from an eve Bot's action. */
export const HARNESS_CALL = "harness";

export async function getProposal(workspaceId: string, actionId: string): Promise<EmailProposal | null> {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(actionId)) return null;
  return (await readDoc<EmailProposal>(proposalKey(workspaceId, actionId)).catch(() => null))?.value ?? null;
}

/**
 * Proposes an email for the job's run and asks the person. The same email
 * asked twice in one run is one proposal (the ledger's id is derived from the
 * job, the run and the payload), and is asked about once.
 */
export async function proposeEmail(input: {
  readonly workspaceId: string;
  readonly jobId: string;
  readonly botId: string;
  readonly runToken: string;
  readonly sessionId: string;
  readonly requester: string;
  readonly payload: EmailPayload;
}): Promise<{ readonly actionId: string; readonly state: string; readonly decided: EmailProposal["decided"] }> {
  const { action, created } = await proposeAction({
    workspaceId: input.workspaceId,
    jobId: input.jobId,
    run: { token: input.runToken, session: input.sessionId },
    kind: "email.send",
    target: [...input.payload.to, ...input.payload.cc],
    payload: input.payload,
    requester: input.requester,
    callId: HARNESS_CALL,
  });
  const existing = await getProposal(input.workspaceId, action.actionId);
  if (existing !== null) return { actionId: action.actionId, state: action.state, decided: existing.decided };
  const proposal: EmailProposal = {
    actionId: action.actionId,
    workspaceId: input.workspaceId,
    jobId: input.jobId,
    botId: input.botId,
    sessionId: input.sessionId,
    payload: input.payload,
    at: new Date().toISOString(),
    decided: null,
  };
  await writeDoc(proposalKey(input.workspaceId, action.actionId), proposal);
  if (created) {
    // A "needs you" push and the card in the Bot's thread both come from this.
    await record({
      workspaceId: input.workspaceId,
      kind: "input.requested",
      botId: input.botId,
      jobId: input.jobId,
      text: `Waiting on a human: send "${input.payload.subject}" to ${input.payload.to.join(", ")}?`,
      data: { proposal: action.actionId, room: `bot:${input.botId}` },
    });
  }
  return { actionId: action.actionId, state: action.state, decided: null };
}

export type Decision =
  | { readonly ok: true; readonly outcome: "approved" | "denied"; readonly status: string; readonly message: string }
  | { readonly ok: false; readonly status: 400 | 404 | 409; readonly error: string };

/** How a session is told what became of its proposal; best effort, and absent in tests. */
export type TellSession = (engine: HarnessEngine, sessionId: string, text: string) => Promise<void>;

/**
 * A person's answer to a proposal. Approving sends the email once, exactly as
 * proposed; denying sends nothing. Either way the Bot hears of it.
 */
export async function decideProposal(input: {
  readonly workspaceId: string;
  readonly actionId: string;
  readonly by: string;
  readonly approve: boolean;
  readonly settings: Readonly<Record<string, string | undefined>>;
  readonly signal?: AbortSignal;
  readonly tell?: TellSession;
}): Promise<Decision> {
  const proposal = await getProposal(input.workspaceId, input.actionId);
  const action = await getAction(input.workspaceId, input.actionId);
  if (proposal === null || action === null || action.callId !== HARNESS_CALL) return { ok: false, status: 404, error: "No such request." };
  if (proposal.decided !== null) return { ok: false, status: 409, error: `Already ${proposal.decided.outcome} by ${proposal.decided.by}.` };
  // What is sent is what was proposed, byte for byte, or nothing.
  if (hashArgs(proposal.payload) !== action.argsHash) return { ok: false, status: 409, error: "This email changed since it was proposed, so it was not sent." };
  const job = await getJob(input.workspaceId, proposal.jobId);
  if (job === null || job.status === "cancelled") return { ok: false, status: 409, error: "The job was cancelled, so nothing is sent." };

  let status = "denied";
  let message = `You declined to send "${proposal.payload.subject}". It was not sent.`;
  if (input.approve) {
    const endpoint = input.settings.BOT_EMAIL_WEBHOOK?.trim();
    if (!endpoint) return { ok: false, status: 400, error: "No email webhook is set (Settings, Email), so nothing can be sent." };
    const result = (await executeEmail({
      workspaceId: input.workspaceId,
      action,
      approver: input.by,
      endpoint,
      payload: proposal.payload,
      settings: input.settings,
      signal: input.signal ?? new AbortController().signal,
      botId: proposal.botId,
    })) as { status: string; reason?: string };
    status = result.status;
    message =
      status === "sent"
        ? `Sent "${proposal.payload.subject}" to ${proposal.payload.to.join(", ")}.`
        : `"${proposal.payload.subject}" was not sent: ${result.reason ?? status}.`;
  }
  const decided = { outcome: input.approve ? ("approved" as const) : ("denied" as const), by: input.by, at: new Date().toISOString(), status };
  await updateDoc<EmailProposal>(proposalKey(input.workspaceId, input.actionId), (current) => (current === null ? current : { ...current, decided }));
  if (!input.approve) {
    await record({ workspaceId: input.workspaceId, kind: "job.progress", botId: proposal.botId, jobId: proposal.jobId, text: message }).catch(() => undefined);
  }
  // The Bot's session hears of it while it is still the job's run; a finished run has the feed.
  const engine = engineOf(await (await import("../bots")).getBot(input.workspaceId, proposal.botId).catch(() => null));
  if (input.tell && engine !== "eve" && job.lease?.session === proposal.sessionId) {
    await input.tell(engine, proposal.sessionId, `A person ${input.approve ? "approved" : "declined"} your email "${proposal.payload.subject}". ${message} Do not send it again.`).catch(() => undefined);
  }
  return { ok: true, outcome: decided.outcome, status, message };
}
