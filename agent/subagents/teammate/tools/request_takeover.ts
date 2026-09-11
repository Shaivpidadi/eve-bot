import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

import { syncIdentity, toolIo } from "../../../lib/computer/runtime";
import { finishHandover, liveControl, sessionBinding, setControl, teamScreen } from "../../../lib/computer/screens";
import { operator } from "../../../lib/session";
import { browser } from "../lib/browser";

/**
 * Hands the Bot's live browser to a person for the one step only a person can
 * do. The request waits as an approval in the Bot's thread and on its screen;
 * the operator opens the computer, takes control, does the step, and returns
 * control, which approves it. Passwords go straight into the page and never
 * through chat or tool input.
 */
export default defineTool({
  description:
    "Ask a person to take over your browser for a step only they can do: signing in, a password or 2FA code, a CAPTCHA, a device or passkey prompt, or a payment page. Open the page first, so they land on it. They work in your live browser directly, so secrets never pass through chat. Never ask for passwords or codes in a message instead. When they return control, read the page again before you continue.",
  inputSchema: z.object({
    reason: z
      .string()
      .min(8)
      .max(300)
      .describe('What they need to do, in one sentence. For example: "Sign in to Gmail with the team\'s Google account."'),
    url: z.string().max(500).optional().describe("The page this is about, if it helps."),
  }),
  approval: always(),
  label: { start: ({ reason }) => `Asking you to take over: ${reason}` },
  async execute({ reason }, ctx) {
    const who = operator(ctx);
    const binding = await sessionBinding(who.workspaceId, ctx.session.id);
    if (binding === null) {
      return { handedBack: false as const, note: "Call job_brief first: it sets up your screen." };
    }
    const screen = await teamScreen(who.workspaceId);
    const n = screen?.n ?? binding.n;
    // Returning control releases it; a lock left behind must not stall the Bot.
    if (screen !== null && liveControl(screen) !== null) await setControl(n, null);
    const personSaid = await finishHandover(n);
    try {
      // Whatever they signed in to goes into the team's jar, which backups carry.
      await syncIdentity(await toolIo(ctx), n);
    } catch {
      // The sign-in still holds in this browser.
    }
    const page = await browser(ctx, ["snapshot", "-i"]);
    return {
      handedBack: true as const,
      reason,
      personSaid,
      page: page.ok ? page.output : null,
      note: "Your browser is back. The page may have changed while they worked: read it, confirm the step actually succeeded, and carry on. If it did not, ask again with a clearer reason.",
    };
  },
});
