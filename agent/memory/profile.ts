import { defineMemory } from "eve/memory";

import { byWorkspace, namespaceFor, workspaceMemory } from "../lib/memory";

/**
 * Who the person is and how they like things done.
 *
 * The workspace's, not the caller's: a workspace usually belongs to one
 * person, and what they teach HQ should reach every Bot. Filled by the
 * capture hook after each exchange (see `lib/memory/hook.ts`), by HQ's
 * `profile__remember`, and by hand in the console.
 */
export default defineMemory({
  description: "Who the person you work for is and how they like things done: name, company, timezone, formats, tone, accounts, standing instructions.",
  namespace: namespaceFor("profile"),
  provider: workspaceMemory("profile", { owner: "hq" }),
  scope: byWorkspace,
});
