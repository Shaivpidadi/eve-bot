import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

import { record } from "../../../lib/activity";
import { getJob } from "../../../lib/jobs";
import { operator } from "../../../lib/session";

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
  approval: always(),
  label: {
    start: ({ to, subject }) => `Email ${to.join(", ")} — ${subject}`,
  },
  async execute(input, ctx) {
    const who = operator(ctx);
    const job = await getJob(who.workspaceId, input.jobId);
    const endpoint = process.env.BOT_EMAIL_WEBHOOK;

    if (endpoint === undefined) {
      return {
        sent: false as const,
        reason:
          "No BOT_EMAIL_WEBHOOK configured, so nothing was sent. This draft is the deliverable: report it as unsent. Do not send it any other way (a mail website, another tool, or the computer).",
        draft: { to: input.to, cc: input.cc ?? [], subject: input.subject, body: input.body },
      };
    }

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(process.env.BOT_EMAIL_WEBHOOK_TOKEN
          ? { authorization: `Bearer ${process.env.BOT_EMAIL_WEBHOOK_TOKEN}` }
          : {}),
      },
      body: JSON.stringify({
        to: input.to,
        cc: input.cc ?? [],
        subject: input.subject,
        text: input.body,
        jobId: input.jobId,
      }),
      signal: ctx.abortSignal,
    });

    if (!response.ok) {
      throw new Error(`Sender returned ${response.status}: ${(await response.text()).slice(0, 300)}`);
    }

    await record({
      workspaceId: who.workspaceId,
      kind: "job.progress",
      botId: job?.botId ?? null,
      jobId: input.jobId,
      text: `Sent "${input.subject}" to ${input.to.join(", ")}.`,
    });

    return { sent: true as const, to: input.to, subject: input.subject };
  },
});
