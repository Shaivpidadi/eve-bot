import { defineMemory } from "eve/memory";
import { fileMemory } from "eve/memory/file";
import { byPrincipal } from "eve/memory/scope";

/**
 * What working for this operator has taught the bots.
 *
 * Separate from a bot's `playbook` (which is per-bot and replayed into every
 * brief): this slot is recalled automatically at the start of a job and holds
 * craft — the quirks of the systems this operator uses, the shape of a good
 * deliverable, the traps found the hard way.
 */
export default defineMemory({
  description:
    "Lessons about doing this operator's work well: the systems they use, where the interfaces are awkward, what a finished deliverable looks like here.",
  provider: fileMemory({ maxCharacters: 4_000 }),
  scope: byPrincipal,
});
