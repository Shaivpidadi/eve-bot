import { randomUUID } from "node:crypto";

import { applyAction, type Action, type ActionError, type ActionEvent, type ActionReceipt } from "./actions";
import { record } from "./activity";

/**
 * Sending one approved email through the relay, recorded in the action ledger
 * (`actions.ts`) so a retry never sends twice on its own. Shared by the two
 * ways a Bot sends: an eve Bot's `send_email` (approved by eve's card before
 * it runs) and a Claude Code or Codex Bot's proposal, approved by a person in
 * the console (`engines/proposals.ts`). See the eve tool for the guarantees.
 */

/** Exactly what the relay receives, apart from the action id itself. */
export interface EmailPayload {
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly subject: string;
  readonly text: string;
  readonly jobId: string;
}

/** How long one relay request may take before its outcome counts as unknown. */
export const emailTimeoutMs = (env: Readonly<Record<string, string | undefined>> = process.env): number => {
  const value = Number(env.BOT_EMAIL_WEBHOOK_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : 30_000;
};
/** An attempt still `executing` this long after it began died mid-send. */
const staleAfterMs = () => emailTimeoutMs() + 60_000;

/**
 * Takes an action the caller holds an approval for from the ledger to a sent
 * (or honestly unknown) email: an attempt that died is recorded as unknown, a
 * proposal is approved by `approver`, one attempt begins, the relay is asked
 * once, and its answer is written. Returns what the model (or the person) is
 * told, from `report`.
 */
export async function executeEmail(input: {
  readonly workspaceId: string;
  readonly action: Action;
  /** Who said yes, for the ledger; null when it is not known. */
  readonly approver: string | null;
  readonly endpoint: string;
  readonly payload: EmailPayload;
  readonly settings: Readonly<Record<string, string | undefined>>;
  readonly signal: AbortSignal;
  /** The Bot whose job it is, for the feed. */
  readonly botId: string;
}) {
const { action } = input;
const apply = (event: ActionEvent) => applyAction(input.workspaceId, action.actionId, event);
  const now = () => new Date().toISOString();

  let current: Action = action;
  if (current.state === "executing" && Date.parse(current.startedAt ?? current.updatedAt) + staleAfterMs() < Date.now()) {
    // An attempt began and never came back: it may have sent. Say so on the record.
    const lost = await apply({
      type: "lose",
      attemptId: current.attemptId ?? "",
      error: { message: "The attempt stopped before the relay's answer was recorded.", httpStatus: null, retryable: false, at: now() },
      at: now(),
    });
    if (lost.action !== null) current = lost.action;
  }
  if (current.state === "proposed" || current.state === "approved") {
    // The caller holds an approval for exactly this payload: eve's card, or a person's yes in the console.
    const approved = await apply({ type: "approve", approver: input.approver, at: now() });
    if (approved.action !== null) current = approved.action;
  }
  const startable = current.state === "approved" || (current.state === "failed" && current.error?.retryable === true);
  if (!startable) return report(current, true);

  const attemptId = randomUUID();
  let begun;
  try {
    begun = await apply({ type: "begin", attemptId, at: now() });
  } catch {
    // The store's retries ran out: the attempt was not admitted, so nothing may be sent.
    return notAdmitted(action.actionId);
  }
  if (!begun.ok || begun.action.attemptId !== attemptId) {
    return begun.action === null ? notAdmitted(action.actionId) : report(begun.action, true);
  }

  const outcome = await post(input.endpoint, { ...input.payload, actionId: action.actionId }, action.actionId, input.signal, input.settings);
  let settled: Action;
  try {
    const written = await apply(
      outcome.type === "succeed"
        ? { type: "succeed", attemptId, receipt: outcome.receipt, at: outcome.at }
        : { type: outcome.type, attemptId, error: outcome.error, at: outcome.at },
    );
    settled = written.action ?? { ...begun.action, state: stateOf(outcome) };
  } catch {
    // The relay's answer is known but could not be stored. Report what
    // happened; the record stays `executing` and a later look reads it as
    // unknown, which never resends (and the relay dedupes the key anyway).
    settled = {
      ...begun.action,
      state: stateOf(outcome),
      ...(outcome.type === "succeed" ? { receipt: outcome.receipt } : { error: outcome.error }),
    };
  }

  if (settled.state === "succeeded" || settled.state === "delivery_unknown") {
    await record({
      workspaceId: input.workspaceId,
      kind: "job.progress",
      botId: input.botId,
      jobId: action.jobId,
      text:
        settled.state === "succeeded"
          ? `Sent "${input.payload.subject}" to ${input.payload.to.join(", ")}.`
          : `Email "${input.payload.subject}" to ${input.payload.to.join(", ")} may or may not have gone out; check the sender (action ${action.actionId}).`,
    }).catch(() => undefined);
  }
  return report(settled, false);
}

type Outcome =
  | { type: "succeed"; receipt: ActionReceipt; at: string }
  | { type: "fail" | "lose"; error: ActionError; at: string };

const stateOf = (outcome: Outcome): Action["state"] =>
  outcome.type === "succeed" ? "succeeded" : outcome.type === "fail" ? "failed" : "delivery_unknown";

/**
 * One request to the relay, classified by what it proves.
 *
 * Only a 2xx proves the email was accepted, and only a 4xx that is about the
 * request itself proves it was not. A timeout, a dropped connection, a 5xx, a
 * 408 or a 409 (the relay still working on the same key) leave it possible
 * that the relay accepted, so they are `lose`: delivery unknown, never resent.
 */
async function post(endpoint: string, body: Record<string, unknown>, actionId: string, abort: AbortSignal, settings: Readonly<Record<string, string | undefined>>): Promise<Outcome> {
  const at = () => new Date().toISOString();
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": actionId,
        ...(settings.BOT_EMAIL_WEBHOOK_TOKEN ? { authorization: `Bearer ${settings.BOT_EMAIL_WEBHOOK_TOKEN}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.any([abort, AbortSignal.timeout(emailTimeoutMs(settings))]),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { type: "lose", error: { message: `No answer from the sender: ${message}`, httpStatus: null, retryable: false, at: at() }, at: at() };
  }

  const text = await response.text().catch(() => "");
  if (response.ok) {
    const answer = parse(text);
    const providerId = [answer.id, answer.messageId, answer.receiptId].find((value) => typeof value === "string") ?? null;
    return {
      type: "succeed",
      receipt: {
        providerId: providerId as string | null,
        status: typeof answer.status === "string" ? answer.status : "accepted",
        httpStatus: response.status,
        at: at(),
      },
      at: at(),
    };
  }
  const error = (retryable: boolean): ActionError => ({
    message: `Sender returned ${response.status}: ${text.slice(0, 300)}`,
    httpStatus: response.status,
    retryable,
    at: at(),
  });
  const status = response.status;
  if (status >= 500 || status === 408 || status === 409) return { type: "lose", error: error(false), at: at() };
  return { type: "fail", error: error(status === 429), at: at() };
}

function parse(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export const notAdmitted = (actionId: string) => ({
  sent: false as const,
  status: "not_admitted" as const,
  actionId,
  reason: "The send could not be recorded before sending, so nothing was sent. Try the same call again shortly.",
});

/** What the model is told about an action, in words it acts on. `earlier`: this call did not send it. */
export function report(action: Action, earlier: boolean) {
  const base = { actionId: action.actionId, to: [...action.target] };
  switch (action.state) {
    case "succeeded":
      return {
        ...base,
        sent: true as const,
        status: "sent" as const,
        receipt: action.receipt,
        ...(earlier ? { note: "This exact email was already sent in this run; it was not sent again." } : {}),
      };
    case "failed":
      return {
        ...base,
        sent: false as const,
        status: "failed" as const,
        retryable: action.error?.retryable ?? false,
        reason: `The sender refused this email: ${action.error?.message ?? "no reason given"}. It was not sent.`,
      };
    case "delivery_unknown":
      return {
        ...base,
        sent: false as const,
        status: "delivery_unknown" as const,
        reason:
          "The sender may or may not have accepted this email. Do not send it again, by this tool or any other way: report it as possibly sent so a person can check the sender's log.",
      };
    case "executing":
      return {
        ...base,
        sent: false as const,
        status: "in_progress" as const,
        reason: "Another attempt is sending this exact email right now. Do not send it again; report it as in progress.",
      };
    default:
      return notAdmitted(action.actionId);
  }
}
