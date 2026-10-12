import { defineTool } from "eve/tools";
import type { ApprovalStatus } from "eve/tools/approval";
import { z } from "zod";

import { operator } from "../../../lib/session";

import { carryOut, loadProposal, sameWords } from "../lib/gate";

/**
 * The only way a consequential browser action happens: a person approves it.
 *
 * `page_click`, `page_fill` with submit, `page_set`, `page_upload` and
 * `page_pilot` never send, pay, publish or delete on their own. When the gate
 * in `lib/gate.ts` flags an action they stop and hand back a proposal; this
 * tool asks for it. The approval is eve's, required on every call, and it is
 * bound to that one stored proposal: the request shows the person the
 * proposal's own description, and a call whose description does not match
 * the stored one, names a proposal from another session, or names one already
 * used is denied before anyone is asked.
 *
 * After approval the proposal is used once, the run is checked against its job
 * (a cancelled or superseded run does nothing), and the page and element are
 * read again: if they no longer match what was approved, nothing happens and
 * the Bot proposes again.
 */
const inputSchema = z.object({
  proposal: z.string().min(3).max(80).describe("The proposal id a browser tool returned."),
  action: z.string().min(3).max(1_000).describe("The proposal's action text, exactly as the browser tool returned it."),
});

type Input = z.infer<typeof inputSchema>;

export default defineTool({
  description:
    "Ask a person to approve one browser action that another browser tool stopped at because it could send, spend, publish, delete or commit something, and carry it out if they do. Pass the proposal id and its action text exactly as returned. Only use it when the brief calls for that action. If the page changed since, nothing happens and you are asked to propose it again.",
  inputSchema,
  approval: async ({ session, toolInput }): Promise<ApprovalStatus> => {
    const input = toolInput as Partial<Input> | undefined;
    if (typeof input?.proposal !== "string" || typeof input.action !== "string") {
      return { type: "denied", reason: "Pass the proposal id and its action text exactly as the browser tool returned them." };
    }
    const proposal = await loadProposal(operator({ session }).workspaceId, session.id, input.proposal);
    if (proposal === null) {
      return { type: "denied", reason: "There is no such pending browser action for this run. Propose it again with the tool that made it." };
    }
    if (proposal.usedAt !== undefined) {
      return { type: "denied", reason: "That proposal was already used. Propose the action again if it is still needed." };
    }
    if (Date.parse(proposal.expiresAt) < Date.now()) {
      return { type: "denied", reason: "That proposal is too old. Read the page and propose the action again." };
    }
    if (!sameWords(proposal.description, input.action)) {
      return { type: "denied", reason: `The action text must match the proposal exactly. It reads: ${proposal.description}` };
    }
    // Never "approved": only a person approves.
    return "user-approval";
  },
  label: { start: ({ action }) => action },
  async execute({ proposal, action }, ctx) {
    const done = await carryOut(ctx, proposal, action);
    if (!done.ok) {
      return {
        done: false as const,
        proposal,
        reason: done.reason,
        error: done.message,
        ...(done.drift === undefined ? {} : { changed: done.drift }),
      };
    }
    if (!done.result.ok) {
      return { done: false as const, proposal, reason: "failed", error: done.result.error, detail: done.result.detail };
    }
    const { ok: _ok, ...seen } = done.result;
    return {
      done: true as const,
      proposal,
      action: done.proposal.description,
      ...seen,
      verify: "Confirm on the page that it did what was intended, and keep a screenshot of the confirmation.",
    };
  },
});
