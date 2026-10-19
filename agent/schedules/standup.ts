import { defineSchedule } from "eve/schedules";

import ops from "../channels/ops";
import { getBot } from "../lib/bots";
import { botIdForRoom, HQ_ROOM, roomAttributes } from "../lib/rooms";
import { standupCron, standupRoom } from "../lib/standup";
import { effectiveEnv } from "../lib/settings/store";

/**
 * A morning report, the way a teammate would give one.
 *
 * Handler form rather than a markdown prompt, because the digest has to land in
 * a room a person actually reads — and because the session it starts can park
 * on a follow-up question instead of evaporating. It posts to HQ's desk unless
 * `BOT_STANDUP_ROOM` names another room the console shows; the cron is UTC
 * (see `lib/standup.ts`).
 */
export default defineSchedule({
  cron: standupCron(),
  run({ to, waitUntil, appAuth }) {
    const workspaceId = process.env.BOT_DEFAULT_WORKSPACE ?? "default";
    waitUntil(
      (async () => {
        let room = standupRoom(await effectiveEnv().catch(() => process.env));
        // A Bot's room is only on the board while the Bot is on the roster.
        const botId = botIdForRoom(room);
        if (botId !== null && (await getBot(workspaceId, botId).catch(() => null)) === null) room = HQ_ROOM;
        await to(ops, { workspaceId, room }).send(
          [
            "Write the daily standup for the team.",
            "Use activity_feed and list_jobs to see what happened since yesterday.",
            "Cover, in this order and nothing else: what shipped, what is in flight,",
            "what is blocked on a human, and what failed. One line each, names not ids.",
            "If nothing happened, say exactly that in one sentence.",
          ].join(" "),
          { auth: { ...appAuth, attributes: roomAttributes(workspaceId, room) } },
        );
      })(),
    );
  },
});
