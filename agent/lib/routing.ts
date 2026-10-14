import { findBot, getBot, HQ_BOT_ID, isHq } from "./bots";
import type { Bot } from "./types";

/**
 * Who does the work: whoever was asked.
 *
 * Work asked for in a Bot's thread is that Bot's, and work asked of HQ is HQ's
 * own. It moves to someone else only when the person names or tags them in the
 * message that asked for it ("@Ava, pull the numbers"). Before this, work with
 * no Bot named fell to the generalist, so a Bot asked to read the email could
 * quietly hand it to Atlas.
 */
export type Route =
  | { readonly ok: true; readonly bot: Bot; readonly by: "thread" | "named" }
  | { readonly ok: false; readonly reason: string };

/** Whether `text` names `name`, tagged ("@Ava") or not ("ask Ava"), as a whole word. */
export function mentions(text: string, name: string): boolean {
  const escaped = name.trim().replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (escaped === "") return false;
  return new RegExp(`(^|[^\\p{L}\\p{N}_])@?${escaped}(?=$|[^\\p{L}\\p{N}_])`, "iu").test(text);
}

/** "me", "you", "yourself": the model's ways of saying the thread's own teammate. */
const SELF = new Set(["me", "you", "yourself", "myself", "self"]);

export async function routeWork(input: {
  readonly workspaceId: string;
  /** The Bot whose thread this is, or null for HQ's. */
  readonly threadBotId: string | null;
  /** What the model passed as `bot`, if anything. */
  readonly named: string | undefined;
  /** The person's latest message in this thread, when known. */
  readonly asked: string | null;
  /** A turn the runtime started (a due job, a report), with no person's words to go by. */
  readonly automated: boolean;
}): Promise<Route> {
  const ownerId = input.threadBotId ?? HQ_BOT_ID;
  const owner = await getBot(input.workspaceId, ownerId);
  if (owner === null) return { ok: false, reason: "This thread's Bot is no longer on the team." };

  const reference = input.named?.trim() ?? "";
  if (reference === "" || SELF.has(reference.toLowerCase()) || reference.toLowerCase() === owner.name.toLowerCase() || reference === owner.id) {
    return { ok: true, bot: owner, by: "thread" };
  }

  const target = reference.toLowerCase() === "hq" || isHq(reference) ? await getBot(input.workspaceId, HQ_BOT_ID) : await findBot(input.workspaceId, reference);
  if (target === null) {
    return { ok: false, reason: `No teammate called ${reference}. Leave bot out to do it yourself.` };
  }
  if (target.id === owner.id) return { ok: true, bot: owner, by: "thread" };

  // Handing work on is the person's call, made in their own words.
  if (!input.automated && (input.asked === null || !mentions(input.asked, target.name))) {
    return {
      ok: false,
      reason: `${owner.name} was asked, so ${owner.name} does it: leave bot out. Hand work to ${target.name} only when the person names or tags them (@${target.name}) in their message.`,
    };
  }
  return { ok: true, bot: target, by: "named" };
}
