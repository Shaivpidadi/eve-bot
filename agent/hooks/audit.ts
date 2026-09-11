import { defineHook } from "eve/hooks";
import type { HookContext } from "eve/hooks";

import { record } from "../lib/activity";
import { isSystemMessage } from "../lib/rooms";
import { noteActive, notePending, notePreview, noteResolved, noteSession } from "../lib/roomstate";
import { operator } from "../lib/session";

/**
 * Writes the moments that matter into durable records.
 *
 * The feed is the record of what the team did: it outlives sessions and is what
 * an operator reads after being away for a day. The room state is what the
 * roster shows at a glance — the last line said, a turn in progress, anything
 * waiting on a person. Hooks are at-least-once and a throwing hook fails the
 * turn, so every write here is idempotent, best-effort, and swallowed.
 */

/** Child sessions (a teammate at work) report through their parent's room. */
const isRoot = (ctx: HookContext) => ctx.session.parent === undefined;

async function quietly(work: () => Promise<unknown>): Promise<void> {
  try {
    await work();
  } catch {
    // Never let bookkeeping take down a turn.
  }
}

async function settle(_event: unknown, ctx: HookContext): Promise<void> {
  if (!isRoot(ctx)) return;
  const who = operator(ctx);
  await quietly(() => noteActive(who.workspaceId, who.room, false));
}

export default defineHook({
  events: {
    async "message.received"(event, ctx) {
      if (!isRoot(ctx)) return;
      const auth = ctx.session.auth.current;
      if (auth?.principalType !== "user" || isSystemMessage(event.data.message)) return;
      const who = operator(ctx);
      await quietly(() =>
        notePreview(who.workspaceId, who.room, "you", event.data.message, new Date().toISOString()),
      );
    },

    async "message.completed"(event, ctx) {
      if (!isRoot(ctx) || event.data.message === null) return;
      const who = operator(ctx);
      const message = event.data.message;
      await quietly(() =>
        notePreview(who.workspaceId, who.room, "bot", message, new Date().toISOString()),
      );
    },

    async "turn.started"(_event, ctx) {
      if (!isRoot(ctx)) return;
      const who = operator(ctx);
      await quietly(() => noteSession(who.workspaceId, who.room, ctx.session.id));
      await quietly(() => noteActive(who.workspaceId, who.room, true));
    },

    // Every way a turn can end clears the room's busy state: a session whose
    // turn failed may never reach `session.waiting`.
    "session.waiting": settle,
    "turn.completed": settle,
    "turn.cancelled": settle,

    async "input.requested"(event, ctx) {
      if (!isRoot(ctx)) return;
      const who = operator(ctx);
      const at = new Date().toISOString();
      const requests = event.data.requests.map((request) => ({
        requestId: request.requestId,
        kind: request.kind,
        prompt: request.prompt.split("\n")[0]?.slice(0, 200) ?? "",
        at,
      }));
      await quietly(() => notePending(who.workspaceId, who.room, requests));
      await quietly(() =>
        record({
          workspaceId: who.workspaceId,
          kind: "input.requested",
          botId: who.botId,
          text: `Waiting on a human: ${requests[0]?.prompt || "input"}`,
          data: { room: who.room, requestIds: requests.map((request) => request.requestId) },
        }),
      );
    },

    async "input.resolved"(event, ctx) {
      if (!isRoot(ctx)) return;
      const who = operator(ctx);
      const ids = event.data.resolutions.map((resolution) => resolution.requestId);
      await quietly(() => noteResolved(who.workspaceId, who.room, ids));
    },

    async "turn.failed"(event, ctx) {
      if (!isRoot(ctx)) return;
      const who = operator(ctx);
      await quietly(() => noteActive(who.workspaceId, who.room, false));
      await quietly(() =>
        record({
          workspaceId: who.workspaceId,
          kind: "job.failed",
          botId: who.botId,
          text: `A turn failed (${event.data.code}): ${event.data.message.slice(0, 280)}`,
          data: { room: who.room, sessionId: ctx.session.id },
        }),
      );
    },
  },
});
