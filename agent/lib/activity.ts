import { newId, timeKey } from "./ids";
import { readDoc, store, writeDoc } from "./store";
import type { ActivityEvent, ActivityKind } from "./types";

const prefix = (workspaceId: string) => `activity/${workspaceId}/`;

/** Events kept per workspace before the oldest are trimmed. */
const RETAIN = Number(process.env.BOT_ACTIVITY_RETAIN ?? 500);
const PRUNE_EVERY = 200;

/** Per workspace, so a busy workspace cannot starve a quiet one of pruning. */
const writesSincePrune = new Map<string, number>();

/**
 * Events never change once written, so a process can keep the ones it has read
 * and a console polling every few seconds only fetches what is new.
 */
const EVENT_CACHE_LIMIT = 5_000;
const eventCache = new Map<string, ActivityEvent>();

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

  const writes = (writesSincePrune.get(input.workspaceId) ?? 0) + 1;
  writesSincePrune.set(input.workspaceId, writes >= PRUNE_EVERY ? 0 : writes);
  if (writes >= PRUNE_EVERY) await pruneActivity(input.workspaceId, RETAIN);

  return event;
}

async function readEvent(key: string): Promise<ActivityEvent | null> {
  const cached = eventCache.get(key);
  if (cached !== undefined) return cached;
  const event = (await readDoc<ActivityEvent>(key))?.value ?? null;
  if (event !== null) {
    eventCache.set(key, event);
    if (eventCache.size > EVENT_CACHE_LIMIT) {
      const oldest = eventCache.keys().next().value;
      if (oldest !== undefined) eventCache.delete(oldest);
    }
  }
  return event;
}

export async function recentActivity(
  workspaceId: string,
  options: { limit?: number; botId?: string; jobId?: string; after?: string } = {},
): Promise<ActivityEvent[]> {
  const limit = options.limit ?? 25;
  const filtered = options.botId !== undefined || options.jobId !== undefined;
  const base = prefix(workspaceId);
  let keys = await store().list(base);

  if (options.after !== undefined && !Number.isNaN(Date.parse(options.after))) {
    // Same millisecond counts as "after": callers dedupe by event id.
    const floor = Date.parse(options.after).toString().padStart(14, "0");
    keys = keys.filter((key) => key.slice(base.length, base.length + 14) >= floor);
  }

  // Read a window, not the archive. Filters widen it, since most of the window
  // may belong to other bots or jobs.
  const window = keys.slice(-(filtered ? Math.max(limit * 20, 200) : limit));
  const events = await Promise.all(window.map(readEvent));

  return events
    .filter((event): event is ActivityEvent => event !== null)
    .filter((event) => (options.botId ? event.botId === options.botId : true))
    .filter((event) => (options.jobId ? event.jobId === options.jobId : true))
    .sort((left, right) => right.at.localeCompare(left.at))
    .slice(0, limit);
}

/** Trims the oldest events so a long-lived workspace does not grow without bound. */
export async function pruneActivity(workspaceId: string, keep = RETAIN): Promise<number> {
  const keys = await store().list(prefix(workspaceId));
  const stale = keys.slice(0, Math.max(0, keys.length - keep));
  await Promise.all(
    stale.map((key) => {
      eventCache.delete(key);
      return store().delete(key);
    }),
  );
  return stale.length;
}
