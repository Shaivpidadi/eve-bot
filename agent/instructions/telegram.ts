import { defineDynamic, defineInstructions } from "eve/instructions";

import { attribute } from "../lib/session";

/**
 * The person is texting HQ from Telegram (see `channels/telegram.ts`), which
 * shows replies as plain text on a phone.
 */
export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) => {
      const auth = ctx.session.auth.current ?? ctx.session.auth.initiator;
      if (attribute(auth, "channel") !== "telegram") return null;
      return defineInstructions({
        content: [
          "## On Telegram",
          "",
          "The operator is texting you from Telegram on their phone.",
          "- Write plain text: no Markdown, no tables, no headings. Telegram shows `**` and `#` as they are.",
          "- Keep replies short, a few lines. Offer more rather than sending it.",
          "- Start work the same way as in the console (assign_job, then run_job). Approvals and questions reach them here as buttons.",
          "- Work started here reports back here: a due job, a routine's report, and a teammate's answer arrive in this chat, so run them and tell the operator the outcome as usual.",
          "- This chat is its own conversation: the console does not show it, but jobs, the board, and the feed are shared.",
        ].join("\n"),
      });
    },
  },
});
