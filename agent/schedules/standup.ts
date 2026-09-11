import { defineSchedule } from "eve/schedules";

import ops from "../channels/ops";
import { roomAttributes } from "../lib/rooms";

/**
 * A morning report, the way a teammate would give one.
 *
 * Handler form rather than a markdown prompt, because the digest has to land in
 * a room a person actually reads — and because the session it starts can park
 * on a follow-up question instead of evaporating.
 */
export default defineSchedule({
  cron: process.env.BOT_STANDUP_CRON ?? "0 13 * * 1-5",
  run({ to, waitUntil, appAuth }) {
    const room = process.env.BOT_STANDUP_ROOM ?? "standup";
    const workspaceId = process.env.BOT_DEFAULT_WORKSPACE ?? "default";
    waitUntil(
      to(ops, { workspaceId, room }).send(
        [
          "Write the daily standup for the team.",
          "Use activity_feed and list_jobs to see what happened since yesterday.",
          "Cover, in this order and nothing else: what shipped, what is in flight,",
          "what is blocked on a human, and what failed. One line each, names not ids.",
          "If nothing happened, say exactly that in one sentence.",
        ].join(" "),
        { auth: { ...appAuth, attributes: roomAttributes(workspaceId, room) } },
      ),
    );
  },
});
