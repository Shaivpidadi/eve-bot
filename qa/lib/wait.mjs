/**
 * Waiting, written once.
 *
 * Every check that follows a job does the same thing: read, look, sleep, read
 * again, give up at a deadline and say what it last saw. These keep that out
 * of the checks so they read like prose.
 */
const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Polls `read()` until `until(value)` is truthy and returns the value. Throws
 * at the deadline with `what` and the last value seen, so a failed wait
 * carries its own evidence.
 */
export async function waitFor(read, { until, what = "the condition", timeoutMs = 120_000, everyMs = 3_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await read();
    if (until(last)) return last;
    if (Date.now() > deadline) {
      const seen = JSON.stringify(last)?.slice(0, 600);
      throw new Error(`Gave up waiting ${Math.round(timeoutMs / 1000)}s for ${what}; last saw ${seen}`);
    }
    await settle(everyMs);
  }
}

/** The feed since `after`, oldest first. */
export async function feed(call, after) {
  const state = await call(`/bot/v1/state?after=${encodeURIComponent(after)}`);
  return [...(state.body?.activity ?? [])].reverse();
}

/** Waits for a feed entry about `jobId` of one of `kinds`, and returns it with everything the feed said about the job. */
export async function waitForJobEvent(call, after, jobId, kinds, options = {}) {
  const wanted = new Set(kinds);
  const events = await waitFor(async () => (await feed(call, after)).filter((entry) => entry.jobId === jobId), {
    ...options,
    what: options.what ?? `a ${[...wanted].join(" or ")} entry for ${jobId}`,
    until: (entries) => entries.some((entry) => wanted.has(entry.kind)),
  });
  return { events, event: events.find((entry) => wanted.has(entry.kind)) };
}

/** Waits for the feed to carry `n` entries of `kind` about `jobId` (a job's progress notes, say). */
export async function waitForJobEvents(call, after, jobId, kind, n, options = {}) {
  return waitFor(async () => (await feed(call, after)).filter((entry) => entry.jobId === jobId && entry.kind === kind), {
    ...options,
    what: options.what ?? `${n} ${kind} entries for ${jobId}`,
    until: (entries) => entries.length >= n,
  });
}
