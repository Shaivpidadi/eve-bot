import { defineMemory } from "eve/memory";
import { fileMemory } from "eve/memory/file";
import { byPrincipal } from "eve/memory/scope";

/**
 * How this particular operator likes things done.
 *
 * Scoped to the authenticated caller, so two people in the same workspace never
 * see each other's preferences. Backed by Vercel Blob on Vercel and by process
 * memory in `eve dev`.
 */
export default defineMemory({
  description:
    "Durable preferences of the person you are working for: tone, formats, recurring accounts and contacts, standing instructions.",
  provider: fileMemory({ maxCharacters: 6_000 }),
  scope: byPrincipal,
});
