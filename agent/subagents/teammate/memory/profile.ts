import { defineMemory } from "eve/memory";

import { byWorkspace, namespaceFor, workspaceMemory } from "../../../lib/memory";

/** The same `profile` HQ keeps, so a Bot knows the person it works for without HQ copying it into the brief. */
export default defineMemory({
  description: "Who the person you work for is and how they like things done. Read it; save here only what they told you directly during a job.",
  namespace: namespaceFor("profile"),
  provider: workspaceMemory("profile", { owner: "bot" }),
  scope: byWorkspace,
});
