import { record } from "./activity";
import { DEFAULT_BOT } from "./default-bot";
import { newId } from "./ids";
import { deleteDoc, isConflict, listDocs, readDoc, updateDoc, writeDoc } from "./store";
import type { Bot } from "./types";

const key = (workspaceId: string, botId: string) => `bots/${workspaceId}/${botId}.json`;
const seedKey = (workspaceId: string) => `defaults/${workspaceId}/default-bot.json`;

/** A seed that has not finished after this long is assumed lost and retried. */
const STALE_SEED_MS = 10 * 60_000;

interface SeedRecord {
  readonly state: "seeding" | "seeded";
  readonly at: string;
  readonly botId?: string;
}

export async function hireBot(input: {
  workspaceId: string;
  hiredBy: string;
  name: string;
  role: string;
  persona: string;
  emoji?: string;
  skills?: string[];
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
    updatedAt: now,
    stats: { jobsCompleted: 0, jobsFailed: 0 },
  };
  await writeDoc(key(bot.workspaceId, bot.id), bot, null);
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
  return (await readDoc<Bot>(key(workspaceId, botId)))?.value ?? null;
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
  const seeding: SeedRecord = { state: "seeding", at: new Date().toISOString() };
  const existing = await readDoc<SeedRecord>(seedKey(workspaceId));
  if (existing !== null) {
    const stalled =
      existing.value.state === "seeding" && Date.now() - Date.parse(existing.value.at) > STALE_SEED_MS;
    if (!stalled) return;
  }
  try {
    await writeDoc(seedKey(workspaceId), seeding, existing?.version ?? null);
  } catch (error) {
    if (isConflict(error)) return;
    throw error;
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
  await deleteDoc(key(workspaceId, botId));
}
