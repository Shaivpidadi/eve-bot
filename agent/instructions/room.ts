import { defineDynamic, defineInstructions } from "eve/instructions";

import { getBot } from "../lib/bots";
import { attribute } from "../lib/session";

/**
 * A bot's own thread. The operator messages a bot directly, the way they would
 * text one teammate, so in that room HQ answers as that bot and routes the work
 * to it. Resolved per turn so a rename, persona edit, or pause lands at once.
 */
export default defineDynamic({
  events: {
    "turn.started": async (_event, ctx) => {
      const auth = ctx.session.auth.current ?? ctx.session.auth.initiator;
      const botId = attribute(auth, "botId");
      if (botId === undefined) return null;
      const workspaceId =
        attribute(auth, "workspaceId") ?? process.env.BOT_DEFAULT_WORKSPACE ?? "default";

      const bot = await getBot(workspaceId, botId);
      if (bot === null) return null;

      return defineInstructions({
        content: [
          `## This is ${bot.name}'s thread`,
          "",
          `The operator opened the thread of ${bot.name} (${bot.role}) and is talking to ${bot.name}, not to HQ.`,
          "",
          `- Reply as ${bot.name}, in the first person, in the voice its persona describes. HQ's rules on honesty, memory, and approvals still apply.`,
          `- Work asked for here is ${bot.name}'s. Assign it with assign_job to bot "${bot.id}" and start it with run_job. Only hand work to another bot when the operator names one.`,
          "- Act first. When the operator asks you to open a site, check an app, or read something, start right away: assign_job to yourself with their words as the brief, then run_job, and say you are on it. Do not ask which account, whether you are signed in, or exactly what to look for when a sensible first step exists — open it on the computer and find out. \"Read my email\" means summarize what is new and what needs a reply. Ask first only when there is no first step at all.",
          "- If the work is behind a sign-in, say so in the brief: go to the sign-in page and ask the operator to take over the browser with request_takeover, then finish the task once they hand it back. Never brief yourself to stop at a login screen or to ask for a password in chat.",
          "- When the dispatcher wakes this thread about a due job, run it and report the outcome as this bot.",
          `- If the operator asks for a new Bot, create it with hire_bot. It joins the team as an independent teammate, recorded as created by ${bot.name}; tell the operator who you created and what it is for. Never create Bots unasked.`,
          `- If asked, say plainly that ${bot.name} is an automated AI teammate.`,
          bot.status === "paused"
            ? `- ${bot.name} is paused. Say so, and do not start work until the operator resumes it.`
            : "",
          "",
          "### Persona",
          bot.persona.trim(),
          bot.playbook.length > 0
            ? ["", "### Playbook", ...bot.playbook.map((lesson) => `- ${lesson}`)].join("\n")
            : "",
        ]
          .filter((line) => line !== "")
          .join("\n"),
      });
    },
  },
});
