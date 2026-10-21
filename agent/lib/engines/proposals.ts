/**
 * Outward actions a Claude Code or Codex Bot asks a person for (plan section
 * 4.3, H2): an email, or a change through a connector. Such a Bot has no eve
 * approval card, so its `send_email` never sends and its `connector_change`
 * never calls a gated tool: each proposes the action in the action ledger
 * (`../actions`), keeps the exact payload here beside it (the ledger holds
 * only its hash), and asks the person, with a "needs you" push and a card in
 * the Bot's thread.
 *
 * When the person approves, eve-bot acts itself, once: an email through the
 * path an eve Bot's approved email takes (`../email-send`), a connector call
 * through `./connector-calls`. The model never calls the tool a second time
 * to make it happen, so a model that forgets, or a replayed call, can neither
 * act twice nor skip it. Approving checks the payload still hashes to what was
 * proposed, that the job was not cancelled and, for a connector, that its
 * settings did not change since; the ledger refuses an approval past its 24
 * hours. Denying leaves the ledger's proposal to expire unused.
 *
 * What happened is told to the Bot's session when it is still the job's run,
 * as a follow-up message; otherwise the job's feed says it.
 */
import { getAction, hashArgs, proposeAction } from "../actions";
import { record } from "../activity";
import { getConnector, permissionVersion } from "../connectors";
import { type EmailPayload, executeEmail } from "../email-send";
import { getJob } from "../jobs";
import { readDoc, updateDoc, writeDoc } from "../store";
import type { ConnectorPayload } from "./connector-calls";
import { engineOf, type HarnessEngine } from "./index";

interface ProposalBase {
  readonly actionId: string;
  readonly workspaceId: string;
  readonly jobId: string;
  readonly botId: string;
  /** The session that asked, so the answer can be told to it. */
  readonly sessionId: string;
  readonly at: string;
  readonly decided: { readonly outcome: "approved" | "denied"; readonly by: string; readonly at: string; readonly status: string } | null;
}

/** An email to send. Proposals kept before connector calls existed have no `kind`, and are emails. */
export interface EmailProposal extends ProposalBase {
  readonly kind?: "email";
  readonly payload: EmailPayload;
}

/** A connector call to make, under the connector settings it was asked under. */
export interface ConnectorProposal extends ProposalBase {
  readonly kind: "connector";
  readonly payload: ConnectorPayload;
  readonly permissionVersion: number;
  /** What the server answered, once it was called: for the card, and the Bot. */
  readonly result?: string;
}

export type Proposal = EmailProposal | ConnectorProposal;

const proposalKey = (workspaceId: string, actionId: string) => `proposals/${workspaceId}/${actionId}.json`;

/** The `callId` a harness proposal carries in the ledger, telling it from an eve Bot's action. */
export const HARNESS_CALL = "harness";

export async function getProposal(workspaceId: string, actionId: string): Promise<Proposal | null> {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(actionId)) return null;
  return (await readDoc<Proposal>(proposalKey(workspaceId, actionId)).catch(() => null))?.value ?? null;
}

interface ProposeInput {
  readonly workspaceId: string;
  readonly jobId: string;
  readonly botId: string;
  readonly runToken: string;
  readonly sessionId: string;
  readonly requester: string;
}

type Proposed = { readonly actionId: string; readonly state: string; readonly decided: Proposal["decided"] };

/**
 * Proposes the action for the job's run and asks the person. The same action
 * asked twice in one run is one proposal (the ledger's id is derived from the
 * job, the run and the payload), and is asked about once.
 */
async function propose(
  input: ProposeInput,
  ask: { readonly kind: "email.send" | "connector.call"; readonly target: readonly string[]; readonly payload: unknown; readonly question: string },
  proposal: (base: ProposalBase) => Proposal,
): Promise<Proposed> {
  const { action, created } = await proposeAction({
    workspaceId: input.workspaceId,
    jobId: input.jobId,
    run: { token: input.runToken, session: input.sessionId },
    kind: ask.kind,
    target: ask.target,
    payload: ask.payload,
    requester: input.requester,
    callId: HARNESS_CALL,
  });
  const existing = await getProposal(input.workspaceId, action.actionId);
  if (existing !== null) return { actionId: action.actionId, state: action.state, decided: existing.decided };
  await writeDoc(
    proposalKey(input.workspaceId, action.actionId),
    proposal({ actionId: action.actionId, workspaceId: input.workspaceId, jobId: input.jobId, botId: input.botId, sessionId: input.sessionId, at: new Date().toISOString(), decided: null }),
  );
  if (created) {
    // A "needs you" push and the card in the Bot's thread both come from this.
    await record({
      workspaceId: input.workspaceId,
      kind: "input.requested",
      botId: input.botId,
      jobId: input.jobId,
      text: `Waiting on a human: ${ask.question}`,
      data: { proposal: action.actionId, room: `bot:${input.botId}` },
    });
  }
  return { actionId: action.actionId, state: action.state, decided: null };
}

/** Proposes an email for the job's run and asks the person. */
export function proposeEmail(input: ProposeInput & { readonly payload: EmailPayload }): Promise<Proposed> {
  return propose(
    input,
    { kind: "email.send", target: [...input.payload.to, ...input.payload.cc], payload: input.payload, question: `send "${input.payload.subject}" to ${input.payload.to.join(", ")}?` },
    (base) => ({ ...base, kind: "email", payload: input.payload }),
  );
}

/** Proposes a connector call for the job's run, under the connector's settings now, and asks the person. */
export function proposeConnectorCall(input: ProposeInput & { readonly payload: ConnectorPayload; readonly permissionVersion: number }): Promise<Proposed> {
  return propose(
    input,
    { kind: "connector.call", target: [`${input.payload.label} ${input.payload.tool}`], payload: input.payload, question: `run ${input.payload.tool} on ${input.payload.label}?` },
    (base) => ({ ...base, kind: "connector", payload: input.payload, permissionVersion: input.permissionVersion }),
  );
}

export type Decision =
  | { readonly ok: true; readonly outcome: "approved" | "denied"; readonly status: string; readonly message: string }
  | { readonly ok: false; readonly status: 400 | 404 | 409; readonly error: string };

/** How a session is told what became of its proposal; best effort, and absent in tests. */
export type TellSession = (engine: HarnessEngine, sessionId: string, text: string) => Promise<void>;

/**
 * A person's answer to a proposal. Approving sends the email, or makes the
 * connector call, once, exactly as proposed; denying does nothing. Either way
 * the Bot hears of it.
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
  // What runs is what was proposed, byte for byte, or nothing.
  if (hashArgs(proposal.payload) !== action.argsHash) return { ok: false, status: 409, error: "This request changed since it was proposed, so nothing was done." };
  const job = await getJob(input.workspaceId, proposal.jobId);
  if (job === null || job.status === "cancelled") return { ok: false, status: 409, error: "The job was cancelled, so nothing is done." };

  let status = "denied";
  let message: string;
  let result: string | undefined;
  if (proposal.kind === "connector") {
    const { decide, executeConnectorCall } = await import("./connector-calls");
    const { payload } = proposal;
    message = `You declined to run ${payload.tool} on ${payload.label}. It was not run.`;
    if (input.approve) {
      const live = await getConnector(input.workspaceId, payload.connectorId).catch(() => null);
      const decision = decide(live, payload.tool);
      if (live === null || decision.kind === "refuse") return { ok: false, status: 409, error: decision.kind === "refuse" ? `${decision.reason} Nothing was run.` : "This connector was removed. Nothing was run." };
      if (permissionVersion(live) !== proposal.permissionVersion) {
        return { ok: false, status: 409, error: `${live.label}'s settings changed since this was asked, so it was not run. Decline it; the Bot can ask again.` };
      }
      const ran = await executeConnectorCall({ workspaceId: input.workspaceId, action, approver: input.by, live, payload, botId: proposal.botId });
      status = ran.status;
      result = ran.text;
      message =
        ran.status === "done"
          ? `Ran ${payload.tool} on ${payload.label}. It answered: ${ran.text}`
          : ran.status === "unknown"
            ? `${payload.tool} on ${payload.label} may or may not have run (${ran.text}). Check before trying again.`
            : `${payload.tool} on ${payload.label} did not run: ${ran.text}`;
    }
  } else {
    message = `You declined to send "${proposal.payload.subject}". It was not sent.`;
    if (input.approve) {
      const endpoint = input.settings.BOT_EMAIL_WEBHOOK?.trim();
      if (!endpoint) return { ok: false, status: 400, error: "No email webhook is set (Settings, Email), so nothing can be sent." };
      const sent = (await executeEmail({
        workspaceId: input.workspaceId,
        action,
        approver: input.by,
        endpoint,
        payload: proposal.payload,
        settings: input.settings,
        signal: input.signal ?? new AbortController().signal,
        botId: proposal.botId,
      })) as { status: string; reason?: string };
      status = sent.status;
      message =
        status === "sent"
          ? `Sent "${proposal.payload.subject}" to ${proposal.payload.to.join(", ")}.`
          : `"${proposal.payload.subject}" was not sent: ${sent.reason ?? status}.`;
    }
  }
  const decided = { outcome: input.approve ? ("approved" as const) : ("denied" as const), by: input.by, at: new Date().toISOString(), status };
  await updateDoc<Proposal>(proposalKey(input.workspaceId, input.actionId), (current) =>
    current === null ? current : ({ ...current, decided, ...(result === undefined ? {} : { result: result.slice(0, 4_000) }) } as Proposal),
  );
  if (!input.approve) {
    await record({ workspaceId: input.workspaceId, kind: "job.progress", botId: proposal.botId, jobId: proposal.jobId, text: message }).catch(() => undefined);
  }
  // The Bot's session hears of it while it is still the job's run; a finished run has the feed.
  const engine = engineOf(await (await import("../bots")).getBot(input.workspaceId, proposal.botId).catch(() => null));
  if (input.tell && engine !== "eve" && job.lease?.session === proposal.sessionId) {
    const what = proposal.kind === "connector" ? `request to run ${proposal.payload.tool} on ${proposal.payload.label}` : `email "${proposal.payload.subject}"`;
    await input.tell(engine, proposal.sessionId, `A person ${input.approve ? "approved" : "declined"} your ${what}. ${message.slice(0, 6_000)} Do not ask for it again.`).catch(() => undefined);
  }
  return { ok: true, outcome: decided.outcome, status, message };
}
