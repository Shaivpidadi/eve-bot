// The background worker: a Vercel Daemon that asks the app to do the watchdog's
// work every 30 seconds (see agent/lib/worker.ts), so due jobs, teammates' notes
// and idle browsers move with no console open. Production only; no dependencies.
//
// A daemon takes no inbound traffic, so it calls the app's production address
// with the OIDC token Vercel keeps fresh in VERCEL_OIDC_TOKEN_FILE.
import { readFile } from "node:fs/promises";

// The pace starts from the environment; each answer from the app carries the one
// set in Settings, so a change there needs no redeploy.
let everyMs = Number(process.env.BOT_WORKER_EVERY_SECONDS ?? 30) * 1000;
let paused = false;
const base = (process.env.BOT_PUBLIC_URL?.trim() || `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`).replace(/\/+$/, "");
const stop = new AbortController();
process.on("SIGTERM", () => stop.abort());

async function token() {
  const file = process.env.VERCEL_OIDC_TOKEN_FILE;
  if (file) return (await readFile(file, "utf8")).trim();
  return process.env.VERCEL_OIDC_TOKEN?.trim() ?? "";
}

async function tick() {
  const headers = { authorization: `Bearer ${await token()}` };
  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim();
  if (bypass) headers["x-vercel-protection-bypass"] = bypass;
  const started = Date.now();
  const response = await fetch(`${base}/bot/v1/internal/tick`, { method: "POST", headers, signal: AbortSignal.any([stop.signal, AbortSignal.timeout(120_000)]) });
  const body = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${body.slice(0, 200)}`);
  const outcome = JSON.parse(body);
  if (Number.isFinite(outcome.everySeconds) && outcome.everySeconds >= 10) everyMs = outcome.everySeconds * 1000;
  if ((outcome.paused === true) !== paused) {
    paused = outcome.paused === true;
    console.log(paused ? "[worker] paused in Settings; asking again each pass" : "[worker] resumed");
  }
  if (outcome.due > 0 || outcome.notes > 0 || process.env.BOT_WORKER_VERBOSE === "1") {
    console.log(`[worker] ${outcome.due} due, ${outcome.dispatched} dispatched, ${outcome.notes} notes, ${Date.now() - started}ms`);
  }
}

const wait = (ms) => new Promise((resolve) => { const timer = setTimeout(resolve, ms); stop.signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true }); });

// Shipped in every deployment's vercel.json, but off until BOT_WORKER=on: on
// Hobby its store traffic would use up Vercel Blob's monthly operations in hours.
if (!/^(1|true|on|yes)$/i.test(process.env.BOT_WORKER?.trim() ?? "")) {
  console.log("[worker] off: set BOT_WORKER=on (Pro plans; see docs/configuration.md) and redeploy to turn it on");
  // Stay up (an exited daemon is restarted at once), asleep until Vercel stops it.
  const awake = setInterval(() => undefined, 60 * 60_000);
  await new Promise((resolve) => stop.signal.addEventListener("abort", resolve, { once: true }));
  clearInterval(awake);
  process.exit(0);
}

console.log(`[worker] calling ${base} every ${everyMs / 1000}s`);
let failures = 0;
while (!stop.signal.aborted) {
  try {
    await tick();
    failures = 0;
  } catch (error) {
    if (stop.signal.aborted) break;
    failures += 1;
    // One line per failure, then quieter: a deploy in progress fails a few passes.
    if (failures <= 3 || failures % 20 === 0) console.error(`[worker] tick failed (${failures}): ${error instanceof Error ? error.message : String(error)}`);
  }
  await wait(failures === 0 ? everyMs : Math.min(everyMs * 2 ** Math.min(failures, 4), 10 * 60_000));
}
console.log("[worker] stopped");
