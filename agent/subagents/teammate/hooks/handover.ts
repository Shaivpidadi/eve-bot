import { defineHook } from "eve/hooks";

import { record } from "../../../lib/activity";
import { clearHandovers, sessionBinding, setHandover } from "../../../lib/computer/screens";
import { getJob } from "../../../lib/jobs";
import { roomForBot } from "../../../lib/rooms";
import { operator } from "../../../lib/session";

/**
 * A Bot at work asking a person to take over its browser.
 *
 * The request is an approval inside the teammate's own session, which the
 * root agent's hooks never see, so the handover is recorded here: on the Bot's
 * screen, where the console's roster, banner, and computer view read it. It
 * clears when the request resolves, or when the Bot resumes (`request_takeover`).
 * Bookkeeping must never take down the Bot's turn, so failures are swallowed.
 */
const TAKEOVER_TOOL = /(^|__)request_takeover$/;

export default defineHook({
  events: {
    async "input.requested"(event, ctx) {
      const takeover = event.data.requests.find(
        (request) => request.kind === "tool-approval" && TAKEOVER_TOOL.test(request.action?.toolName ?? ""),
      );
      if (takeover === undefined) return;
      try {
        const { workspaceId } = operator(ctx);
        const binding = await sessionBinding(workspaceId, ctx.session.id);
        if (binding === null) return;
        const job = await getJob(workspaceId, binding.jobId);
        const input = takeover.action?.input ?? {};
        const reason =
          typeof input.reason === "string" ? input.reason.slice(0, 300) : "Needs you to take over its browser";
        await setHandover(binding.n, {
          reason,
          url: typeof input.url === "string" ? input.url.slice(0, 500) : null,
          at: new Date().toISOString(),
          room: job?.room ?? roomForBot(binding.botId),
          requestId: takeover.requestId,
          jobId: binding.jobId,
          botId: binding.botId,
        });
        await record({
          workspaceId,
          kind: "input.requested",
          botId: binding.botId,
          jobId: binding.jobId,
          text: `Needs you to take over its browser: ${reason}`,
          data: { requestIds: [takeover.requestId] },
        });
      } catch {
        // The card in the thread still asks.
      }
    },

    async "input.resolved"(event, ctx) {
      try {
        const { workspaceId } = operator(ctx);
        await clearHandovers(
          workspaceId,
          event.data.resolutions.map((resolution) => resolution.requestId),
        );
      } catch {
        // request_takeover clears it when the Bot resumes.
      }
    },
  },
});
