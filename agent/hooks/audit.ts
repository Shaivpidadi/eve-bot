import { failure } from "eve/events";
import { defineHook } from "eve/hooks";
import type { HookContext } from "eve/hooks";

import { record } from "../lib/activity";
import { isSystemMessage } from "../lib/rooms";
import { noteActive, noteAsked, notePending, notePreview, noteResolved, noteSession, noteTurnStarted } from "../lib/roomstate";
import { textOfParts } from "../lib/events";
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

export default defineHook({
  events: {
    async "delivery.consumed"(event, ctx) {
      if (!isRoot(ctx)) return;
      const auth = ctx.session.auth.current;
      const message = textOfParts(event.data.parts);
      if (auth?.principalType !== "user" || message === "" || isSystemMessage(message)) return;
      const who = operator(ctx);
      const at = new Date().toISOString();
      await quietly(() => notePreview(who.workspaceId, who.room, "you", message, at));
      await quietly(() => noteAsked(who.workspaceId, who.room, message, at));
    },

    async "content.completed"(event, ctx) {
      if (!isRoot(ctx) || event.data.kind !== "text" || event.data.phase !== "reply") return;
      const message = typeof event.data.value === "string" ? event.data.value : "";
      if (message.trim() === "") return;
      const who = operator(ctx);
      await quietly(() => notePreview(who.workspaceId, who.room, "bot", message, new Date().toISOString()));
    },

    async "turn.started"(_event, ctx) {
      if (!isRoot(ctx)) return;
      const who = operator(ctx);
      await quietly(() => noteSession(who.workspaceId, who.room, ctx.session.id));
      await quietly(() => noteTurnStarted(who.workspaceId, who.room));
    },

    // Every way a turn ends clears the room's busy state; a failure is also kept in the feed.
    async "turn.settled"(event, ctx) {
      if (!isRoot(ctx)) return;
      const who = operator(ctx);
      await quietly(() => noteActive(who.workspaceId, who.room, false));
      if (event.data.outcome !== "failed") return;
      const error = event.data.error ?? failure(ctx.view, event.data.turnId);
      await quietly(() =>
        record({
          workspaceId: who.workspaceId,
          kind: "job.failed",
          botId: who.botId,
          text: `A turn failed (${error?.code ?? "unknown"}): ${(error?.message ?? "no detail").slice(0, 280)}`,
          // `turn`: the thread shows this from its own stream; the feed keeps it for the Activity panel.
          data: { room: who.room, sessionId: ctx.session.id, turn: true },
        }),
      );
    },

    async "interaction.opened"(event, ctx) {
      if (!isRoot(ctx)) return;
      const who = operator(ctx);
      const at = new Date().toISOString();
      const { interactionId, request } = event.data;
      const prompt = (request.title ?? request.prompt).split("\n")[0]?.slice(0, 200) ?? "";
      await quietly(() => notePending(who.workspaceId, who.room, [{ requestId: interactionId, kind: request.kind, prompt, at }]));
      await quietly(() =>
        record({
          workspaceId: who.workspaceId,
          kind: "input.requested",
          botId: who.botId,
          text: `Waiting on a human: ${prompt || "input"}`,
          data: { room: who.room, requestIds: [interactionId] },
        }),
      );
    },

    async "interaction.settled"(event, ctx) {
      if (!isRoot(ctx)) return;
      const who = operator(ctx);
      await quietly(() => noteResolved(who.workspaceId, who.room, [event.data.interactionId]));
    },
  },
});
