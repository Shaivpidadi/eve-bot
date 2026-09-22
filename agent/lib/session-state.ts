/**
 * Per-session scratch state, with a ceiling.
 *
 * A teammate's browser work leaves notes keyed by session: the tab this run
 * opened, the screen it warmed, the last page it read, the directories it has
 * already made. Each one is small, and each one is written once per job and
 * never removed. A deployment that redeploys often never notices; a standalone
 * server that runs for months holds one entry per job it has ever run.
 *
 * Sessions end in roughly the order they begin, so the oldest entry is the one
 * least likely to belong to a run still going. Dropping it costs at worst one
 * repeated lookup.
 */
export interface SessionState<T> {
  get(id: string): T | undefined;
  has(id: string): boolean;
  set(id: string, value: T): void;
  delete(id: string): void;
}

const DEFAULT_LIMIT = 200;

export function sessionState<T>(limit: number = DEFAULT_LIMIT): SessionState<T> {
  const entries = new Map<string, T>();
  return {
    get: (id) => entries.get(id),
    has: (id) => entries.has(id),
    set(id, value) {
      if (!entries.has(id) && entries.size >= limit) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
      }
      entries.set(id, value);
    },
    delete: (id) => {
      entries.delete(id);
    },
  };
}
