import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

import { approvalOf, noteApproval, proposeAction } from "../../../lib/actions";
import { executeEmail } from "../../../lib/email-send";
import { guardSideEffect } from "../../../lib/run-guard";
import { markPoint } from "../lib/journal";
import { operator } from "../../../lib/session";
import { effectiveEnv } from "../../../lib/settings/store";

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
    response: async ({ response, request, session }) => {
      await noteApproval(session.id, request.callId, response.principal.principalId);
      return { status: "allowed" };
    },
  },
  label: {
    start: ({ to, subject }) => `Email ${to.join(", ")} — ${subject}`,
  },
  async execute(input, ctx) {
    const who = operator(ctx);
    // The webhook and its token come from Settings over the environment (the token sealed there).
    const settings = await effectiveEnv();
    const endpoint = settings.BOT_EMAIL_WEBHOOK?.trim() || undefined;
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
          "No email webhook is set (Settings, Email), so nothing was sent. This draft is the deliverable: report it as unsent. Do not send it any other way (a mail website, another tool, or the computer).",
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
    // An email cannot be unsent; the files as they were before it are a point to rewind to.
    await markPoint(ctx, input.jobId, "before email");

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
    return executeEmail({ workspaceId: who.workspaceId, action, approver: (await approvalOf(ctx.session.id, ctx.callId))?.approver ?? null, endpoint, payload, settings, signal: ctx.abortSignal, botId: job.botId });
  },
});
