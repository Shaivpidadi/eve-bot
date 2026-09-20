/**
 * Bots testing Bots: the runner.
 *
 * `npm test` covers the pure plumbing, and the parts of this product that
 * actually break — a job that closes without doing the work, an approval that
 * does not hold, a cancelled job that comes back — are not pure and are not
 * covered by anything. This drives a running deployment over its own console
 * API, asserts the things that must be exact, and keeps the evidence when one
 * of them is not.
 *
 * It never runs against the machine you work on by accident: it needs QA_URL
 * and QA_TOKEN, and it refuses a URL it was not pointed at deliberately.
 * Point it at a staging deployment with its own computer and its own data.
 */

export class CheckFailure extends Error {
  constructor(message, evidence = {}) {
    super(message);
    this.name = "CheckFailure";
    this.evidence = evidence;
  }
}

/** Asserts something that must be exactly so, and says what it saw when it is not. */
export function expect(actual, matcher, what, evidence = {}) {
  const ok = typeof matcher === "function" ? matcher(actual) : Object.is(actual, matcher);
  if (!ok) {
    throw new CheckFailure(`${what}: expected ${typeof matcher === "function" ? matcher.name || "it to match" : JSON.stringify(matcher)}, got ${JSON.stringify(actual)?.slice(0, 300)}`, evidence);
  }
  return actual;
}

/** One HTTP call against the deployment under test, with the token unless told otherwise. */
export function client({ url, token, timeoutMs = 20_000 }) {
  const base = url.replace(/\/+$/, "");
  return async function call(path, options = {}) {
    const response = await fetch(`${base}${path}`, {
      method: options.method ?? "GET",
      headers: {
        ...(options.anonymous === true ? {} : { authorization: `Bearer ${token}` }),
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        ...options.headers,
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: AbortSignal.timeout(options.timeoutMs ?? timeoutMs),
    });
    const text = await response.text();
    let body;
    try {
      body = text === "" ? null : JSON.parse(text);
    } catch {
      body = text.slice(0, 2_000);
    }
    return { status: response.status, body, headers: response.headers };
  };
}

/**
 * Runs checks with a ceiling on how many at once.
 *
 * Concurrency is bounded because these share one deployment: a hundred
 * parallel workers would be testing the queue, not the behaviour.
 */
export async function runChecks(checks, context, { concurrency = 3, onResult = () => {} } = {}) {
  const queue = [...checks];
  const results = [];
  const workers = Array.from({ length: Math.min(concurrency, queue.length || 1) }, async () => {
    for (;;) {
      const check = queue.shift();
      if (check === undefined) return;
      const started = Date.now();
      try {
        const outcome = await check.run(context);
        const skipped = typeof outcome === "object" && outcome !== null && "skipped" in outcome;
        const result = {
          name: check.name,
          ok: true,
          skipped: skipped ? outcome.skipped : false,
          ms: Date.now() - started,
          detail: skipped ? null : (outcome ?? null),
        };
        results.push(result);
        onResult(result);
      } catch (error) {
        const result = {
          name: check.name,
          ok: false,
          ms: Date.now() - started,
          error: error instanceof Error ? error.message : String(error),
          evidence: error instanceof CheckFailure ? error.evidence : {},
        };
        results.push(result);
        onResult(result);
      }
    }
  });
  await Promise.all(workers);
  return results.sort((left, right) => checks.findIndex((c) => c.name === left.name) - checks.findIndex((c) => c.name === right.name));
}
