import { record } from "./activity";
import { newId } from "./ids";
import { deleteDoc, listDocs, readDoc, updateDoc, writeDoc } from "./store";
import type { Bot } from "./types";

const key = (workspaceId: string, botId: string) => `bots/${workspaceId}/${botId}.json`;

export async function hireBot(input: {
  workspaceId: string;
  hiredBy: string;
  name: string;
  role: string;
  persona: string;
  emoji?: string;
  skills?: string[];
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
    updatedAt: now,
    stats: { jobsCompleted: 0, jobsFailed: 0 },
  };
  await writeDoc(key(bot.workspaceId, bot.id), bot, null);
  await record({
    workspaceId: bot.workspaceId,
    kind: "bot.hired",
    botId: bot.id,
    text: `${bot.emoji} ${bot.name} joined the team as ${bot.role}.`,
  });
  return bot;
}

export async function getBot(workspaceId: string, botId: string): Promise<Bot | null> {
  return (await readDoc<Bot>(key(workspaceId, botId)))?.value ?? null;
}

export async function listBots(workspaceId: string): Promise<Bot[]> {
  const bots = await listDocs<Bot>(`bots/${workspaceId}/`);
  return bots.sort((left, right) => left.hiredAt.localeCompare(right.hiredAt));
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
