import { defineHook } from "eve/hooks";

import { computerControl } from "../../../lib/computer/control";
import { closeFinishedTabs } from "../../../lib/computer/tab-sweep";
import { handsFor } from "../../../lib/hands";
import { clearBotTab, sessionBinding } from "../../../lib/computer/screens";
import { getJob } from "../../../lib/jobs";
import { operator, type AuthedContext } from "../../../lib/session";

/**
 * A run works in its own tab of the team's shared browser (see `lib/browser.ts`).
 * When its job is over, that tab has done its job: close it so the window does
 * not fill with the tabs of finished jobs, and forget which tab was this Bot's.
 * The team's sign-ins live in the browser profile, not the tab, so closing it
 * loses nothing.
 *
 * Since eve 0.79 a run's session parks after each turn instead of ending, so
 * the end of a turn is where this looks: a job that is done, failed or
 * cancelled lets its tab go, and one still open (a sign-off, a takeover, a
 * routine's next cycle) keeps it. Any other finished job's recorded tab goes
 * too. Best-effort throughout: a tab that cannot be closed is tried again on
 * the next pass, and never fails the run.
 */
async function closeRunTab(ctx: AuthedContext & { readonly session: { readonly id: string } }, whenOver: boolean): Promise<void> {
  try {
    const { workspaceId } = operator(ctx);
    const binding = await sessionBinding(workspaceId, ctx.session.id);
    if (binding === null) return;
    if (whenOver) {
      const job = await getJob(workspaceId, binding.jobId);
      if (job !== null && !["done", "failed", "cancelled"].includes(job.status)) return;
    }
    await clearBotTab(workspaceId, binding.botId, ctx.session.id);
    const io = await computerControl().io();
    if (io === null) return;
    const hands = handsFor(io);
    if (binding.targetId !== undefined) await hands.browser.close(binding.n, binding.targetId).catch(() => undefined);
    await closeFinishedTabs(workspaceId, hands);
  } catch {
    // The tab outlives the run; the next pass, or the idle reaper, takes it.
  }
}

export default defineHook({
  events: {
    async "turn.settled"(_event, ctx) {
      await closeRunTab(ctx, true);
    },
    async "session.ended"(_event, ctx) {
      await closeRunTab(ctx, false);
    },
  },
});
