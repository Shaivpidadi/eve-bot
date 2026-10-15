import { findBot, getBot, HQ_BOT_ID, isHq, listBots } from "./bots";
import { confidenceFloor, judge } from "./jev";
import type { Bot } from "./types";

/**
 * Who does the work, in this order:
 *
 * 1. Whoever the person tagged or named in their message ("@Ava, pull the numbers").
 * 2. Otherwise the teammate whose role fits the task best, chosen by Jev from the
 *    Bots already on the team. A generalist never counts as a fit: it would
 *    fit everything, and HQ would never do anything itself. In a Bot's own thread that Bot is the default and
 *    keeps the work unless another Bot clearly fits much better: the person
 *    asked it, so it does not quietly pass the job to the generalist.
 * 3. Otherwise HQ does it itself, on HQ's desk; in a Bot's thread, that Bot.
 *
 * Jev is optional (see `jev.ts`): when it is off or unsure, the model's own
 * pick stands on HQ's desk, and a Bot keeps work asked in its thread.
 */
export type Route =
  | { readonly ok: true; readonly bot: Bot; readonly by: "named" | "fit" | "thread" | "hq" }
  | { readonly ok: false; readonly reason: string };

/** Whether `text` names `name`, tagged ("@Ava") or not ("ask Ava"), as a whole word. */
export function mentions(text: string, name: string, options: { readonly tagged?: boolean } = {}): boolean {
  const escaped = name.trim().replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (escaped === "") return false;
  return new RegExp(`(^|[^\\p{L}\\p{N}_])${options.tagged ? "@" : "@?"}${escaped}(?=$|[^\\p{L}\\p{N}_])`, "iu").test(text);
}

/** "me", "you", "yourself": the model's ways of saying the thread's own teammate. */
const SELF = new Set(["me", "you", "yourself", "myself", "self"]);

/** How sure Jev must be, and how little it may think of the thread's own Bot, before work leaves that thread. */
const LEAVE_THREAD_BELOW = 0.15;

export interface Fit {
  /** A Bot's id, or "none" when no Bot clearly fits. */
  readonly choice: string;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confident: boolean;
}

export type FitJudge = (task: string, bots: readonly Bot[], workspaceId: string) => Promise<Fit | null>;

/** Asks Jev which Bot's role fits a task, or none. Null when Jev is off, unreachable or slow. */
export const judgeFit: FitJudge = async (task, bots, workspaceId) => {
  if (bots.length === 0) return null;
  const criteria: Record<string, string> = {};
  for (const bot of bots) {
    criteria[bot.id] = [
      `${bot.name}: ${bot.role}.`,
      bot.skills.length > 0 ? `Skills: ${bot.skills.join(", ")}.` : "",
      bot.persona.split("\n").find((line) => line.trim() !== "")?.slice(0, 240) ?? "",
      bot.playbook.length > 0 ? `Has learned: ${bot.playbook.slice(-3).join(" / ").slice(0, 240)}` : "",
    ]
      .filter((part) => part !== "")
      .join(" ");
  }
  criteria.none = "No teammate's role clearly covers this task.";
  const judgement = await judge(
    { task: task.slice(0, 3000) },
    {
      fit: {
        type: "choice",
        instructions:
          "Which teammate should do this task, judged by the role each one was given? Pick the one whose role is specifically about this kind of work. A generalist, or a role that could take on anything, never counts as a fit: pick none rather than a generalist. Pick none when no role is specifically about it.",
        criteria,
      },
    },
    { workspaceId, timeoutMs: 4000 },
  );
  if (judgement === null) return null;
  const answer = judgement.answers.fit as { choice?: string; probabilities?: Record<string, number> } | undefined;
  if (answer?.choice === undefined) return null;
  const probabilities = answer.probabilities ?? {};
  const confidence = judgement.confidence.fit ?? probabilities[answer.choice];
  return { choice: answer.choice, probabilities, confident: confidence === undefined || confidence >= confidenceFloor() };
};

async function teammate(workspaceId: string, reference: string): Promise<Bot | null> {
  const trimmed = reference.trim().replace(/^@/, "");
  if (trimmed.toLowerCase() === "hq" || isHq(trimmed)) return getBot(workspaceId, HQ_BOT_ID);
  return findBot(workspaceId, trimmed);
}

export async function routeWork(input: {
  readonly workspaceId: string;
  /** The Bot whose thread this is, or null for HQ's desk. */
  readonly threadBotId: string | null;
  /** What the model passed as `bot`, if anything. */
  readonly named: string | undefined;
  /** The person's latest message in this thread, when known. */
  readonly asked: string | null;
  /** The work itself (title and brief), for judging who fits. */
  readonly task: string;
  /** A turn the runtime started (a due job, a teammate's note), with no person's words to go by. */
  readonly automated: boolean;
  readonly fit?: FitJudge;
}): Promise<Route> {
  const hq = await getBot(input.workspaceId, HQ_BOT_ID);
  if (hq === null) return { ok: false, reason: "HQ is unavailable." };
  const owner = input.threadBotId === null ? hq : await getBot(input.workspaceId, input.threadBotId);
  if (owner === null) return { ok: false, reason: "This thread's Bot is no longer on the team." };
  const inThread = input.threadBotId !== null;

  const reference = input.named?.trim() ?? "";
  const pickedSelf = reference === "" || SELF.has(reference.toLowerCase()) || reference.toLowerCase() === owner.name.toLowerCase() || reference === owner.id;
  const picked = pickedSelf ? owner : await teammate(input.workspaceId, reference);
  if (picked === null) return { ok: false, reason: `No teammate called ${reference}. Leave bot out and the best fit is chosen.` };

  // 1. The person's own words: whoever they tagged or named.
  const asked = input.asked ?? "";
  if (!pickedSelf && (input.automated || mentions(asked, picked.name))) return { ok: true, bot: picked, by: "named" };
  if (pickedSelf && asked !== "") {
    const roster = (await listBots(input.workspaceId)).filter((bot) => bot.status === "active" && bot.id !== owner.id);
    const tagged = [...roster, ...(owner.id === hq.id ? [] : [hq])].filter((bot) => mentions(asked, bot.name, { tagged: true }));
    if (tagged.length === 1 && tagged[0] !== undefined) return { ok: true, bot: tagged[0], by: "named" };
  }

  // 2. Who fits, among the Bots already on the team.
  const bots = (await listBots(input.workspaceId)).filter((bot) => bot.status === "active");
  const fit = await (input.fit ?? judgeFit)(input.task, bots, input.workspaceId);
  const chosen = fit?.confident === true && fit.choice !== "none" ? bots.find((bot) => bot.id === fit.choice) : undefined;

  if (inThread) {
    // The person asked this Bot; it keeps the work unless another clearly fits much better.
    const ownerOdds = fit?.probabilities[owner.id] ?? 0;
    if (chosen !== undefined && chosen.id !== owner.id && ownerOdds < LEAVE_THREAD_BELOW) return { ok: true, bot: chosen, by: "fit" };
    return { ok: true, bot: owner, by: "thread" };
  }

  // HQ's desk.
  if (chosen !== undefined) return { ok: true, bot: chosen, by: "fit" };
  if (fit?.confident === true && fit.choice === "none") return { ok: true, bot: hq, by: "hq" };
  // Jev was off or unsure: the model's own pick stands.
  if (!pickedSelf) return { ok: true, bot: picked, by: "fit" };
  return { ok: true, bot: hq, by: "hq" };
}
