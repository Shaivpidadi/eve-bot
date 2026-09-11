import { defineHook } from "eve/hooks";

import { computerControl } from "../../../lib/computer/control";
import { closeTab } from "../../../lib/computer/runtime";
import { clearBotTab, sessionBinding } from "../../../lib/computer/screens";
import { operator, type AuthedContext } from "../../../lib/session";

/**
 * A run works in its own tab of the team's shared browser (see `lib/browser.ts`).
 * When the run ends, that tab has done its job: close it so the window does not
 * fill with the tabs of finished jobs, and forget which tab was this Bot's. The
 * team's sign-ins live in the browser profile, not the tab, so closing it loses
 * nothing. Best-effort throughout: a tab that cannot be closed is left for the
 * idle reaper, and never fails the run.
 */
async function closeRunTab(ctx: AuthedContext & { readonly session: { readonly id: string } }): Promise<void> {
  try {
    const { workspaceId } = operator(ctx);
    const binding = await sessionBinding(workspaceId, ctx.session.id);
    if (binding === null) return;
    await clearBotTab(workspaceId, binding.botId, ctx.session.id);
    if (binding.targetId === undefined) return;
    const io = await computerControl().io();
    if (io !== null) await closeTab(io, binding.n, binding.targetId).catch(() => undefined);
  } catch {
    // The tab outlives the run; the idle reaper stops the browser eventually.
  }
}

export default defineHook({
  events: {
    async "session.completed"(_event, ctx) {
      await closeRunTab(ctx);
    },
    async "session.failed"(_event, ctx) {
      await closeRunTab(ctx);
    },
  },
});
