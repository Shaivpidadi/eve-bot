import { defineHook } from "eve/hooks";

import { record } from "../lib/activity";
import { operator } from "../lib/session";

/**
 * Writes the moments that matter into the durable feed.
 *
 * The conversation transcript is not the record of what the team did — the feed
 * is, because it outlives sessions and is what an operator reads after being
 * away for a day. Hooks are at-least-once and a throwing hook fails the turn, so
 * everything here is best-effort and swallowed.
 */
export default defineHook({
  events: {
    async "input.requested"(event, ctx) {
      try {
        const kinds = [...new Set(event.data.requests.map((request) => request.kind))].join(", ");
        await record({
          workspaceId: operator(ctx).workspaceId,
          kind: "job.blocked",
          text: `Waiting on a human (${kinds || "input"}).`,
          data: { sessionId: ctx.session.id },
        });
      } catch {
        // Never let bookkeeping take down a turn.
      }
    },

    async "turn.failed"(event, ctx) {
      try {
        await record({
          workspaceId: operator(ctx).workspaceId,
          kind: "job.failed",
          text: `A turn failed (${event.data.code}): ${event.data.message.slice(0, 280)}`,
          data: { sessionId: ctx.session.id },
        });
      } catch {
        // Same.
      }
    },
  },
});
