import { record } from "./activity";
import { DEFAULT_BOT } from "./default-bot";
import { newId } from "./ids";
import { createDoc, deleteDoc, isConflict, listDocs, readDoc, updateDoc, writeDoc } from "./store";
import type { Bot } from "./types";

/**
 * HQ is a teammate too: work no Bot fits is done by HQ, on the team's computer,
 * with its own browser tab, folder, playbook and record of jobs. It is stored
 * apart from the roster, so it is never listed, hired, retired or picked as a
 * Bot, while everything that runs a job reads it like one.
 */
export const HQ_BOT_ID = "hq";

const key = (workspaceId: string, botId: string) =>
  botId === HQ_BOT_ID ? `hq/${workspaceId}/worker.json` : `bots/${workspaceId}/${botId}.json`;

export const isHq = (botId: string): boolean => botId === HQ_BOT_ID;

function hqWorker(workspaceId: string): Bot {
  const now = new Date().toISOString();
  return {
    id: HQ_BOT_ID,
    workspaceId,
    name: "HQ",
    role: "Chief of staff: runs the team, and does the work it is asked for itself",
    emoji: "🧭",
    persona: [
      "You are HQ, the team's chief of staff, doing this job yourself: no Bot on the team fits it, or the operator asked you for it.",
      "",
      "- Understand before acting: state the outcome in one line, what done means, and the unknowns in your first log_progress.",
      "- Work in the real tools: the browser for web apps, the shell for data, web search for facts. After every change, look again and confirm it landed.",
      "- Produce a complete first version, review it as a skeptical reviewer would, fix what falls short, then deliver.",
      "",
      "What you never do: send, publish, pay, delete, or change permissions without the approval step; invent facts; claim you verified something you did not; write credentials into files, logs, or messages.",
    ].join("\n"),
    skills: ["research", "browser", "shell", "analysis", "writing", "email"],
    playbook: [],
    status: "active",
    hiredBy: "system",
    hiredAt: now,
    createdBy: null,
    updatedAt: now,
    stats: { jobsCompleted: 0, jobsFailed: 0 },
  };
}
const seedKey = (workspaceId: string) => `defaults/${workspaceId}/default-bot.json`;

/** A seed that has not finished after this long is assumed lost and retried. */
const STALE_SEED_MS = 10 * 60_000;

interface SeedRecord {
  readonly state: "seeding" | "seeded";
  readonly at: string;
  readonly botId?: string;
  /** Which seeding attempt wrote it, so an attempt can recognise its own claim. */
  readonly claim?: string;
}

export async function hireBot(input: {
  workspaceId: string;
  hiredBy: string;
  name: string;
  role: string;
  persona: string;
  emoji?: string;
  skills?: string[];
  intro?: Bot["intro"];
  /** Set when a Bot created this one at the operator's request. */
  createdBy?: { botId: string; name: string };
}): Promise<Bot> {
  const now = new Date().toISOString();
  const bot: Bot = {
    id: newId("bot"),
    workspaceId: input.workspaceId,
    name: input.name,
    role: input.role,
    emoji: input.emoji ?? "🤖",
    persona: input.persona,
    skills: input.skills ?? [],
    playbook: [],
    status: "active",
    hiredBy: input.hiredBy,
    hiredAt: now,
    createdBy: input.createdBy ?? null,
    ...(input.intro ? { intro: input.intro } : {}),
    updatedAt: now,
    stats: { jobsCompleted: 0, jobsFailed: 0 },
  };
  await createDoc(key(bot.workspaceId, bot.id), bot);
  await record({
    workspaceId: bot.workspaceId,
    kind: "bot.hired",
    botId: bot.id,
    text:
      input.createdBy === undefined
        ? `${bot.emoji} ${bot.name} joined the team as ${bot.role}.`
        : `${bot.emoji} ${bot.name} joined the team as ${bot.role}, created by ${input.createdBy.name}.`,
  });
  return bot;
}

export async function getBot(workspaceId: string, botId: string): Promise<Bot | null> {
  const found = (await readDoc<Bot>(key(workspaceId, botId)))?.value ?? null;
  if (found !== null || !isHq(botId)) return found;
  // HQ's worker record comes into being the first time anything asks for it.
  try {
    await createDoc(key(workspaceId, HQ_BOT_ID), hqWorker(workspaceId));
  } catch (error) {
    if (!isConflict(error)) throw error;
  }
  return (await readDoc<Bot>(key(workspaceId, HQ_BOT_ID)))?.value ?? hqWorker(workspaceId);
}

const seededWorkspaces = new Set<string>();

export async function listBots(workspaceId: string): Promise<Bot[]> {
  if (!seededWorkspaces.has(workspaceId)) {
    await seedDefaultBot(workspaceId);
    seededWorkspaces.add(workspaceId);
  }
  const bots = await listDocs<Bot>(`bots/${workspaceId}/`);
  return bots.sort((left, right) => left.hiredAt.localeCompare(right.hiredAt));
}

/**
 * Every workspace starts with one generalist Bot, exactly once. Retiring it
 * later does not bring it back: the seed record, not the roster, says whether
 * seeding happened. The record is a create-only write, so concurrent processes
 * cannot both hire it.
 */
async function seedDefaultBot(workspaceId: string): Promise<void> {
  const seeding: SeedRecord = { state: "seeding", at: new Date().toISOString(), claim: newId("seed") };
  const existing = await readDoc<SeedRecord>(seedKey(workspaceId));
  if (existing !== null) {
    const stalled =
      existing.value.state === "seeding" && Date.now() - Date.parse(existing.value.at) > STALE_SEED_MS;
    if (!stalled) return;
  }
  try {
    await writeDoc(seedKey(workspaceId), seeding, existing?.version ?? null);
  } catch (error) {
    if (!isConflict(error)) throw error;
    // On Blob a claim that landed can come back as a conflict; only another attempt's claim means it is theirs.
    const now = await readDoc<SeedRecord>(seedKey(workspaceId));
    if (now?.value.claim !== seeding.claim) return;
  }

  const bots = await listDocs<Bot>(`bots/${workspaceId}/`);
  const named = bots.find((bot) => bot.name.toLowerCase() === DEFAULT_BOT.name.toLowerCase());
  const bot = named ?? (await hireBot({ workspaceId, hiredBy: "system", ...DEFAULT_BOT }));
  const seeded: SeedRecord = { state: "seeded", at: new Date().toISOString(), botId: bot.id };
  await writeDoc(seedKey(workspaceId), seeded);
}

/** Resolves "Ava", "ava", or `bot_k3f9x2` to one bot, the way a person would refer to it. */
export async function findBot(workspaceId: string, reference: string): Promise<Bot | null> {
  const direct = await getBot(workspaceId, reference);
  if (direct !== null) return direct;
  const needle = reference.trim().toLowerCase();
  const bots = await listBots(workspaceId);
  return bots.find((bot) => bot.name.toLowerCase() === needle) ?? null;
}

export async function patchBot(
  workspaceId: string,
  botId: string,
  patch: (bot: Bot) => Bot,
): Promise<Bot | null> {
  return updateDoc<Bot>(key(workspaceId, botId), (current) =>
    current === null ? null : { ...patch(current), updatedAt: new Date().toISOString() },
  );
}

/** Appends a durable lesson. Bounded, because the playbook is replayed into every brief. */
export async function teachBot(
  workspaceId: string,
  botId: string,
  lesson: string,
  limit = 40,
): Promise<Bot | null> {
  const trimmed = lesson.trim();
  return patchBot(workspaceId, botId, (bot) => ({
    ...bot,
    playbook: bot.playbook.includes(trimmed)
      ? bot.playbook
      : [...bot.playbook, trimmed].slice(-limit),
  }));
}

export async function retireBot(workspaceId: string, botId: string): Promise<void> {
  if (isHq(botId)) throw new Error("HQ runs the team and cannot be retired.");
  await deleteDoc(key(workspaceId, botId));
}
