import { defineMemory } from "eve/memory";

import { byWorkspace, namespaceFor, workspaceMemory } from "../../../lib/memory";

/**
 * What doing this workspace's work has taught the Bots: the quirks of its
 * systems, which formats work, what a finished deliverable looks like here.
 * Shared by every Bot in the workspace, and filled from each job's transcript
 * once the job's turn is over (see `lib/memory/hook.ts`), with Jev deciding
 * what counts as a lesson.
 */
export default defineMemory({
  description: "Lessons about doing this workspace's work well: the systems in use, where their interfaces are awkward, what a finished deliverable looks like here.",
  namespace: namespaceFor("craft"),
  provider: workspaceMemory("craft", { owner: "bot" }),
  scope: byWorkspace,
});
