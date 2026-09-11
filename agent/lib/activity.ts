import { newId, timeKey } from "./ids";
import { readDoc, store, writeDoc } from "./store";
import type { ActivityEvent, ActivityKind } from "./types";

const prefix = (workspaceId: string) => `activity/${workspaceId}/`;

/** Events kept per workspace before the oldest are trimmed. */
const RETAIN = Number(process.env.BOT_ACTIVITY_RETAIN ?? 500);
const PRUNE_EVERY = 200;

let writesSincePrune = 0;

/**
 * Append-only feed. This is what makes a bot's work watchable: every meaningful
 * step lands here, so an operator who stepped away can read what happened
 * instead of scrolling a transcript.
 *
 * Keys are zero-padded timestamps, so the store's sorted key listing is already
 * the timeline — reads fetch only the tail, never the whole history.
 */
export async function record(input: {
  workspaceId: string;
  kind: ActivityKind;
  text: string;
  botId?: string | null;
  jobId?: string | null;
  data?: Record<string, unknown>;
}): Promise<ActivityEvent> {
  const at = new Date().toISOString();
  const event: ActivityEvent = {
    id: newId("act"),
    workspaceId: input.workspaceId,
    at,
    kind: input.kind,
    botId: input.botId ?? null,
    jobId: input.jobId ?? null,
    text: input.text,
    ...(input.data ? { data: input.data } : {}),
  };
  await writeDoc(`${prefix(input.workspaceId)}${timeKey(at)}.json`, event);

  writesSincePrune += 1;
  if (writesSincePrune >= PRUNE_EVERY) {
    writesSincePrune = 0;
    await pruneActivity(input.workspaceId, RETAIN);
  }

  return event;
}

export async function recentActivity(
  workspaceId: string,
  options: { limit?: number; botId?: string; jobId?: string } = {},
): Promise<ActivityEvent[]> {
  const limit = options.limit ?? 25;
  const filtered = options.botId !== undefined || options.jobId !== undefined;
  const keys = await store().list(prefix(workspaceId));

  // Read a window, not the archive. Filters widen it, since most of the window
  // may belong to other bots or jobs.
  const window = keys.slice(-(filtered ? Math.max(limit * 20, 200) : limit));
  const docs = await Promise.all(window.map((key) => readDoc<ActivityEvent>(key)));

  return docs
    .flatMap((doc) => (doc === null ? [] : [doc.value]))
    .filter((event) => (options.botId ? event.botId === options.botId : true))
    .filter((event) => (options.jobId ? event.jobId === options.jobId : true))
    .sort((left, right) => right.at.localeCompare(left.at))
    .slice(0, limit);
}

/** Trims the oldest events so a long-lived workspace does not grow without bound. */
export async function pruneActivity(workspaceId: string, keep = RETAIN): Promise<number> {
  const keys = await store().list(prefix(workspaceId));
  const stale = keys.slice(0, Math.max(0, keys.length - keep));
  await Promise.all(stale.map((key) => store().delete(key)));
  return stale.length;
}
