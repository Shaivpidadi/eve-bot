import { defineMemory } from "eve/memory";

import { byWorkspace, namespaceFor, workspaceMemory } from "../lib/memory";

/**
 * How this workspace works: who approves what, which systems are the source
 * of truth, house style for anything the team publishes. Shared by HQ and
 * every Bot. Filled by the same capture as `profile`, and by hand.
 */
export default defineMemory({
  description: "Conventions that apply to the whole workspace: who approves what, which systems are the source of truth, house style, who to cc.",
  namespace: namespaceFor("team"),
  provider: workspaceMemory("team", { owner: "hq" }),
  scope: byWorkspace,
});
