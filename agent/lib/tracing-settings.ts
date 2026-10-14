/**
 * Whether this deployment sends its runs to Vercel Agent Runs, and whether the
 * traces carry the conversation's content (prompts, tool arguments, results)
 * or only its shape: timings, models, tokens, errors.
 *
 * One record for the whole deployment, set from the console's Settings. The
 * trace hooks in `agent/instrumentation/` are synchronous and run for every
 * span, so they read a copy held in memory; it is refreshed from the store in
 * the background at most once a minute, and at once when the console changes
 * it on this server. Until the first read lands, the defaults hold: runs on,
 * content off.
 */
export interface TracingSettings {
  /** Send runs to Vercel Agent Runs (preview and production deployments only). */
  readonly agentRuns: boolean;
  /** Include prompts, tool arguments and results, not just timings and counts. */
  readonly content: boolean;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
}

export const TRACING_DEFAULTS: TracingSettings = { agentRuns: true, content: false, updatedAt: null, updatedBy: null };

const KEY = "settings/tracing.json";
const REFRESH_MS = 60_000;

let cached: TracingSettings = TRACING_DEFAULTS;
let readAt = 0;
let reading: Promise<void> | null = null;

function normalize(value: Partial<TracingSettings> | null | undefined): TracingSettings {
  return {
    agentRuns: typeof value?.agentRuns === "boolean" ? value.agentRuns : TRACING_DEFAULTS.agentRuns,
    content: typeof value?.content === "boolean" ? value.content : TRACING_DEFAULTS.content,
    updatedAt: typeof value?.updatedAt === "string" ? value.updatedAt : null,
    updatedBy: typeof value?.updatedBy === "string" ? value.updatedBy : null,
  };
}

/** The settings as stored. The store is loaded lazily, so the trace hooks stay light. */
export async function readTracingSettings(): Promise<TracingSettings> {
  const { readDoc } = await import("./store");
  const settings = normalize((await readDoc<Partial<TracingSettings>>(KEY))?.value);
  cached = settings;
  readAt = Date.now();
  return settings;
}

export async function writeTracingSettings(patch: Partial<Pick<TracingSettings, "agentRuns" | "content">>, by: string): Promise<TracingSettings> {
  const { updateDoc } = await import("./store");
  const next = await updateDoc<TracingSettings>(KEY, (current) => ({
    ...normalize(current),
    ...(patch.agentRuns === undefined ? {} : { agentRuns: patch.agentRuns }),
    ...(patch.content === undefined ? {} : { content: patch.content }),
    updatedAt: new Date().toISOString(),
    updatedBy: by,
  }));
  cached = normalize(next);
  readAt = Date.now();
  return cached;
}

/**
 * The settings right now, without waiting: what is in memory, with a refresh
 * started in the background when it is more than a minute old.
 */
export function tracingNow(now: number = Date.now()): TracingSettings {
  if (now - readAt > REFRESH_MS && reading === null) {
    readAt = now;
    reading = readTracingSettings()
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => {
        reading = null;
      });
  }
  return cached;
}
