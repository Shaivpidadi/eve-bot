import { randomUUID } from "node:crypto";

import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

import {
  applyAction,
  approvalOf,
  noteApproval,
  proposeAction,
  type Action,
  type ActionError,
  type ActionEvent,
  type ActionReceipt,
} from "../../../lib/actions";
import { record } from "../../../lib/activity";
import { guardSideEffect } from "../../../lib/run-guard";
import { operator } from "../../../lib/session";

/** How long one relay request may take before its outcome counts as unknown. */
const timeoutMs = () => Number(process.env.BOT_EMAIL_WEBHOOK_TIMEOUT_MS ?? 30_000);
/** An attempt still `executing` this long after it began died mid-send. */
const staleAfterMs = () => timeoutMs() + 60_000;

/**
 * The "lands in the actual tool" seam.
 *
 * Outbound email is the canonical irreversible side effect, so it is gated on a
 * human every single time — the approval prompt surfaces on the operator's
 * channel while the bot's run parks durably, however long that takes.
 *
 * Point BOT_EMAIL_WEBHOOK at your sender (Resend, Postmark, an internal relay).
 * With no webhook configured this returns a draft instead of sending, which is
 * also how you demo the flow safely.
 *
 * Every send is an action in the ledger (`lib/actions.ts`), so a retry never
 * sends twice on its own:
 *
 * - What a person approves is the tool call's input, which the console shows
 *   field by field and eve hands unchanged to `execute`. The relay payload is
 *   built from exactly that input and its hash is part of the action's id, so
 *   the approval binds the bytes sent: a different payload is a different call,
 *   a different action and a fresh approval.
 * - The id also binds the run, so a replayed step (same run, same payload)
 *   finds the first attempt's record and returns its receipt instead of sending.
 *   An identical email asked for twice in one run is sent once.
 * - The relay receives the id as `Idempotency-Key`, and must dedupe on it (see
 *   README, "Outbound email relay"). That covers the gap the ledger cannot: the relay
 *   accepted, then the reply or the receipt write was lost.
 * - An attempt whose outcome is unknown (timeout, dropped connection, 5xx, a
 *   crash mid-send) is recorded `delivery_unknown` and is never resent from
 *   here; a person reconciles it.
 */
export default defineTool({
  description:
    "Send an email on the operator's behalf. Requires human approval every time. With no sender configured it returns the draft instead of sending.",
  inputSchema: z.object({
    jobId: z.string(),
    to: z.array(z.string().max(200)).min(1).max(20),
    subject: z.string().min(1).max(200),
    body: z.string().min(1).max(20_000),
    cc: z.array(z.string().max(200)).max(20).optional(),
  }),
  approval: {
    request: always(),
    // Always allowed, as with `always()` alone; this only remembers who said
    // yes so the ledger can name the approver.
    response: async ({ responder, request, session }) => {
      await noteApproval(session.id, request.callId, responder.principalId);
      return { status: "allowed" };
    },
  },
  label: {
    start: ({ to, subject }) => `Email ${to.join(", ")} — ${subject}`,
  },
  async execute(input, ctx) {
    const who = operator(ctx);
    const endpoint = process.env.BOT_EMAIL_WEBHOOK;
    // Exactly what the relay receives, apart from the action id itself.
    const payload = {
      to: input.to,
      cc: input.cc ?? [],
      subject: input.subject,
      text: input.body,
      jobId: input.jobId,
    };

    if (endpoint === undefined) {
      return {
        sent: false as const,
        status: "draft" as const,
        reason:
          "No BOT_EMAIL_WEBHOOK configured, so nothing was sent. This draft is the deliverable: report it as unsent. Do not send it any other way (a mail website, another tool, or the computer).",
        draft: { to: input.to, cc: payload.cc, subject: input.subject, body: input.body },
      };
    }

    // Checked after approval, at the moment of sending: a job cancelled or
    // taken over by another run while the approval waited sends nothing.
    const guard = await guardSideEffect(ctx, input.jobId);
    if (!guard.ok) {
      return { sent: false as const, status: "refused" as const, reason: guard.reason, message: guard.message };
    }
    const job = guard.job;

    const { action } = await proposeAction({
      workspaceId: who.workspaceId,
      jobId: input.jobId,
      run: { token: job.lease!.token, session: ctx.session.id },
      kind: "email.send",
      target: [...input.to, ...payload.cc],
      payload,
      requester: job.requestedBy,
      callId: ctx.callId,
    });
    const apply = (event: ActionEvent) => applyAction(who.workspaceId, action.actionId, event);
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
      // Reaching execute means eve holds an approval for exactly this input.
      const note = await approvalOf(ctx.session.id, ctx.callId);
      const approved = await apply({ type: "approve", approver: note?.approver ?? null, at: now() });
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

    const outcome = await post(endpoint, { ...payload, actionId: action.actionId }, action.actionId, ctx.abortSignal);
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
        workspaceId: who.workspaceId,
        kind: "job.progress",
        botId: job.botId,
        jobId: input.jobId,
        text:
          settled.state === "succeeded"
            ? `Sent "${input.subject}" to ${input.to.join(", ")}.`
            : `Email "${input.subject}" to ${input.to.join(", ")} may or may not have gone out; check the sender (action ${action.actionId}).`,
      }).catch(() => undefined);
    }
    return report(settled, false);
  },
});

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
async function post(endpoint: string, body: Record<string, unknown>, actionId: string, abort: AbortSignal): Promise<Outcome> {
  const at = () => new Date().toISOString();
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": actionId,
        ...(process.env.BOT_EMAIL_WEBHOOK_TOKEN ? { authorization: `Bearer ${process.env.BOT_EMAIL_WEBHOOK_TOKEN}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.any([abort, AbortSignal.timeout(timeoutMs())]),
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

const notAdmitted = (actionId: string) => ({
  sent: false as const,
  status: "not_admitted" as const,
  actionId,
  reason: "The send could not be recorded before sending, so nothing was sent. Try the same call again shortly.",
});

/** What the model is told about an action, in words it acts on. `earlier`: this call did not send it. */
function report(action: Action, earlier: boolean) {
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
