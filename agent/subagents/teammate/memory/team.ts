import { defineMemory } from "eve/memory";

import { byWorkspace, namespaceFor, workspaceMemory } from "../../../lib/memory";

/** The same `team` HQ keeps: the workspace's conventions, recalled on every job. */
export default defineMemory({
  description: "Conventions that apply to the whole workspace: who approves what, which systems are the source of truth, house style, who to cc.",
  namespace: namespaceFor("team"),
  provider: workspaceMemory("team", { owner: "bot" }),
  scope: byWorkspace,
});
