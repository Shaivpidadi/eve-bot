import { defineMemory } from "eve/memory";
import { byPrincipal } from "eve/memory/scope";

import { appMemory } from "../lib/memory";

/**
 * How this particular operator likes things done.
 *
 * Scoped to the authenticated caller, so two people in the same workspace never
 * see each other's preferences. Kept in the app's store (see `lib/memory.ts`).
 */
export default defineMemory({
  description:
    "Durable preferences of the person you are working for: tone, formats, recurring accounts and contacts, standing instructions.",
  provider: appMemory("profile"),
  scope: byPrincipal,
});
