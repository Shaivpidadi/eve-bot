import { defineMemory } from "eve/memory";
import type { MemoryScopeContext } from "eve/memory";

import { appMemory } from "../lib/memory";

/**
 * Conventions shared by everyone in a workspace: escalation paths, the tools the
 * team actually uses, house style. Scoped to the workspace rather than the
 * caller, so what one person teaches the team survives them.
 */
function byWorkspace(ctx: MemoryScopeContext): string | null {
  const auth = ctx.session.auth.current ?? ctx.session.auth.initiator;
  const attribute = auth?.attributes.workspaceId ?? auth?.attributes.tenantId;
  if (typeof attribute === "string") return attribute;
  if (Array.isArray(attribute) && typeof attribute[0] === "string") return attribute[0];
  return process.env.BOT_DEFAULT_WORKSPACE ?? "default";
}

export default defineMemory({
  description:
    "Conventions that apply to the whole workspace: who approves what, which systems are the source of truth, house style for anything the team publishes.",
  provider: appMemory("team"),
  scope: byWorkspace,
});
