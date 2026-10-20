import { z } from "zod";

import { record } from "./activity";
import { getBot } from "./bots";
import { nudge, NEWS_PER_DAY, NEWS_PER_HOUR, type NudgeResult } from "./notify";

/**
 * The `notify` tool HQ and every Bot carry (docs/plan/notifications.md, N4):
 * one definition, so both describe it and limit it the same way.
 */
export const NOTIFY_DESCRIPTION = [
  "Tell the people in this workspace something new on their phones and computers, unprompted: news a routine found, a change they would want to know now.",
  "Only for news worth an interruption. Never for progress, never to say you finished (that notifies on its own), and never to ask for an approval or an answer (those notify on their own too).",
  `At most ${NEWS_PER_HOUR} an hour and ${NEWS_PER_DAY} a day across the workspace, and the same news (by key) once a day: a routine checking for changes should pass a key that names the thing, such as "hn-top:<story id>", so an unchanged result is never sent twice.`,
  "Quiet hours and each person's choices still apply; held news goes out when their quiet hours end.",
].join(" ");

export const notifyInput = z.object({
  title: z.string().min(1).max(60).describe("A few words, the headline: \"Flight to Lisbon down to $412\"."),
  message: z.string().min(1).max(200).describe("One or two sentences saying what changed and why it matters."),
  key: z
    .string()
    .max(80)
    .optional()
    .describe("Names the news, so the same news is sent once: \"price:lisbon-oct\", \"hn-top:41234567\". Without it, the words are the key."),
});

export async function runNotify(input: z.infer<typeof notifyInput>, who: { workspaceId: string; botId: string | null }): Promise<NudgeResult> {
  const bot = who.botId === null ? null : await getBot(who.workspaceId, who.botId).catch(() => null);
  const name = who.botId === null ? null : (bot?.name ?? "A Bot");
  const result = await nudge({ workspaceId: who.workspaceId, botId: who.botId, who: name, title: input.title, message: input.message, ...(input.key ? { key: input.key } : {}) });
  if (result.sent && result.reached > 0) {
    await record({
      workspaceId: who.workspaceId,
      kind: "push.sent",
      botId: who.botId,
      text: `${name ?? "HQ"} notified: ${input.title}: ${input.message}`.slice(0, 280),
    }).catch(() => undefined);
  }
  return result;
}
