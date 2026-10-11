/**
 * `bot-computer-netguard.mjs`: holds back what a click sends, for the approval
 * gate.
 *
 * The gate reads a control's words and structure before a click. A button
 * labelled "Continue" or "Done" whose page script posts an order, a delete or
 * a message has nothing in its words or its form to give it away. So every
 * click the gate lets through as safe runs with this guard on the run's tab:
 *
 * - `arm PORT TARGET TTL` attaches to the tab over DevTools (and to its
 *   out-of-process frames and workers as they appear) and pauses every request
 *   it makes. It answers once interception is in place, or with why it is not;
 *   the gate then asks a person rather than click unwatched.
 * - While armed, a GET, HEAD or OPTIONS goes on. So does everything once the
 *   click has navigated the tab to another page with a GET: that page's own
 *   loading is not what the click sent. Beacons and requests to well-known
 *   analytics hosts are failed quietly. Any other request (a POST, PUT, PATCH
 *   or DELETE, a JSON call, a form posted from script) is failed before it
 *   leaves the browser, and recorded.
 * - `disarm ID GRACE` waits a moment for what the click set off, stops the
 *   guard, and reports what it stopped. Anything stopped turns the click into
 *   a proposal a person approves, and `page_confirm` then clicks unguarded.
 *
 * Not seen: a request a page's service worker makes on its own, WebSocket
 * messages, a GET with side effects, and anything a page sends after the
 * grace period (a debounced autosave). The guard expires on its own after TTL
 * if it is never disarmed.
 *
 * Runs as the computer's own user, which owns the browser; its files live in
 * the computer's private run folder, out of the Bots' shell's reach. Like the
 * other programs it is a plain string, free of template interpolation and
 * backticks.
 */
export const NETGUARD_FILE = "bot-computer-netguard.mjs";

/** How long the guard stays armed if nobody disarms it. */
export const GUARD_TTL_MS = 30_000;

/** How long a click gets to send what it sends, before the guard reports. */
export const guardGraceMs = (): number => {
  const value = Number(process.env.BOT_BROWSER_GUARD_MS);
  return Number.isFinite(value) && value >= 200 && value <= 10_000 ? value : 1_200;
};

/** What the guard stopped: a request that would have left the browser. */
export interface Stopped {
  readonly method: string;
  readonly url: string;
}

export type GuardReport =
  | { readonly ok: true; readonly blocked: readonly Stopped[]; readonly quiet: number; readonly expired: boolean }
  | { readonly ok: false; readonly error: string };

/** Reads a guard's printed answer; anything unreadable is a failure. */
export function parseGuardAnswer<T extends object>(stdout: string): (T & { ok: true }) | { ok: false; error: string } {
  const line = stdout.trim().split("\n").pop() ?? "";
  try {
    const parsed = JSON.parse(line) as { ok?: unknown; error?: unknown };
    if (parsed.ok === true) return parsed as T & { ok: true };
    return { ok: false, error: typeof parsed.error === "string" ? parsed.error : "the guard failed" };
  } catch {
    return { ok: false, error: line === "" ? "the guard answered nothing" : `the guard answered: ${line.slice(0, 200)}` };
  }
}

export const NETGUARD_JS = String.raw`// bot-computer-netguard __VERSION__: holds back what a click sends, for the approval gate.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";

const DIR = "/tmp/bot-computer/netguard";
const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);
const QUIET_TYPES = new Set(["Ping", "CSPViolationReport"]);
const ANALYTICS = [
  "google-analytics.com", "analytics.google.com", "googletagmanager.com", "doubleclick.net", "googlesyndication.com",
  "segment.io", "segment.com", "amplitude.com", "mixpanel.com", "heapanalytics.com", "heap.io", "hotjar.com", "hotjar.io",
  "sentry.io", "ingest.sentry.io", "datadoghq.com", "datadoghq.eu", "browser-intake-datadoghq.com", "nr-data.net",
  "newrelic.com", "posthog.com", "clarity.ms", "fullstory.com", "logrocket.com", "logrocket.io", "bugsnag.com",
  "vercel-insights.com", "vercel-scripts.com", "plausible.io", "rudderstack.com", "facebook.net", "bat.bing.com",
  "linkedin.com/px", "px.ads.linkedin.com", "stats.wp.com", "pendo.io",
];

const print = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const files = (id) => ({ ready: DIR + "/" + id + ".ready", stop: DIR + "/" + id + ".stop", report: DIR + "/" + id + ".json" });

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function analytics(url) {
  const host = hostOf(url);
  let path = "";
  try {
    path = new URL(url).pathname;
  } catch {}
  return ANALYTICS.some((entry) => {
    const [domain, prefix] = entry.split(/(?=\/)/);
    return (host === domain || host.endsWith("." + domain)) && (prefix === undefined || path.startsWith(prefix));
  });
}

/**
 * What to do with one paused request: "go" (let it leave), "quiet" (fail it,
 * do not count it), or "stop" (fail it and report it). "state" is the guard's
 * memory across requests: once the main frame navigated with a GET, the page
 * that loads is not what the click sent.
 */
function judge(request, state) {
  const method = String(request.method || "GET").toUpperCase();
  if (state.navigated) return "go";
  if (SAFE.has(method)) {
    if (request.resourceType === "Document" && request.mainFrame) state.navigated = true;
    return "go";
  }
  if (QUIET_TYPES.has(request.resourceType) || analytics(request.url)) return "quiet";
  return "stop";
}

async function arm(port, targetId, ttlMs) {
  await mkdir(DIR, { recursive: true, mode: 0o700 });
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  const child = spawn(process.execPath, [process.argv[1], "watch", String(port), targetId, id, String(ttlMs)], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  const paths = files(id);
  for (let i = 0; i < 160; i++) {
    if (existsSync(paths.ready)) {
      const ready = JSON.parse(await readFile(paths.ready, "utf8"));
      return print(ready.ok ? { ok: true, id } : { ok: false, error: ready.error });
    }
    await sleep(50);
  }
  return print({ ok: false, error: "the guard did not start in time" });
}

async function watch(port, targetId, id, ttlMs) {
  const paths = files(id);
  const blocked = [];
  const state = { navigated: false };
  let quiet = 0;
  let mainFrame = null;
  const sessions = new Set();
  const pending = new Map();
  let next = 0;
  let socket;
  const send = (method, params, sessionId) =>
    new Promise((done, failed) => {
      const messageId = ++next;
      pending.set(messageId, { done, failed });
      const message = { id: messageId, method, params: params || {} };
      if (sessionId) message.sessionId = sessionId;
      socket.send(JSON.stringify(message));
    });
  const answer = (method, params, sessionId) => send(method, params, sessionId).catch(() => undefined);

  const follow = async (sessionId, waiting) => {
    sessions.add(sessionId);
    try {
      await send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] }, sessionId);
      await answer("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId);
    } finally {
      if (waiting) await answer("Runtime.runIfWaitingForDebugger", {}, sessionId);
    }
  };

  try {
    const version = await (await fetch("http://127.0.0.1:" + port + "/json/version", { signal: AbortSignal.timeout(5000) })).json();
    socket = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out connecting to the browser")), 5000);
      socket.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      socket.onerror = () => {
        clearTimeout(timer);
        reject(new Error("could not connect to the browser"));
      };
    });
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== undefined) {
        const waiter = pending.get(message.id);
        if (waiter === undefined) return;
        pending.delete(message.id);
        if (message.error) waiter.failed(new Error(message.error.message));
        else waiter.done(message.result);
        return;
      }
      if (message.method === "Fetch.requestPaused") {
        const params = message.params;
        const verdict = judge(
          {
            method: params.request.method,
            url: params.request.url,
            resourceType: params.resourceType,
            mainFrame: mainFrame !== null && params.frameId === mainFrame,
          },
          state,
        );
        if (verdict === "go") {
          answer("Fetch.continueRequest", { requestId: params.requestId }, message.sessionId);
        } else {
          if (verdict === "stop") blocked.push({ method: String(params.request.method), url: String(params.request.url).slice(0, 500) });
          else quiet += 1;
          answer("Fetch.failRequest", { requestId: params.requestId, errorReason: "BlockedByClient" }, message.sessionId);
        }
      } else if (message.method === "Target.attachedToTarget") {
        follow(message.params.sessionId, message.params.waitingForDebugger).catch(() => undefined);
      }
    };
    const attached = await send("Target.attachToTarget", { targetId, flatten: true });
    const tree = await send("Page.getFrameTree", {}, attached.sessionId).catch(() => null);
    mainFrame = tree && tree.frameTree ? tree.frameTree.frame.id : null;
    await follow(attached.sessionId, false);
  } catch (error) {
    await writeFile(paths.ready, JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    process.exit(1);
  }
  await writeFile(paths.ready, JSON.stringify({ ok: true }));

  const until = Date.now() + ttlMs;
  while (Date.now() < until && !existsSync(paths.stop)) await sleep(40);
  for (const sessionId of sessions) await answer("Fetch.disable", {}, sessionId);
  await writeFile(paths.report + ".tmp", JSON.stringify({ ok: true, blocked, quiet, expired: Date.now() >= until }));
  await rename(paths.report + ".tmp", paths.report);
  socket.close();
  process.exit(0);
}

async function disarm(id, graceMs) {
  const paths = files(id);
  await sleep(graceMs);
  await writeFile(paths.stop, "");
  for (let i = 0; i < 100; i++) {
    if (existsSync(paths.report)) {
      const report = JSON.parse(await readFile(paths.report, "utf8"));
      await Promise.all([paths.ready, paths.stop, paths.report].map((path) => rm(path, { force: true })));
      return print(report);
    }
    await sleep(50);
  }
  return print({ ok: false, error: "the guard did not report" });
}

const [command, ...rest] = process.argv.slice(2);
try {
  if (command === "arm" && /^\d+$/.test(rest[0] || "") && /^[A-Za-z0-9_-]+$/.test(rest[1] || "")) {
    await arm(Number(rest[0]), rest[1], Number(rest[2]) || 30000);
  } else if (command === "watch") {
    await watch(Number(rest[0]), rest[1], rest[2], Number(rest[3]) || 30000);
  } else if (command === "disarm" && /^[a-z0-9]+$/.test(rest[0] || "")) {
    await disarm(rest[0], Number(rest[1]) || 1200);
  } else if (command === "judge") {
    const state = JSON.parse(rest[1] || "{}");
    const verdicts = JSON.parse(rest[0] || "[]").map((request) => judge(request, state));
    print({ ok: true, verdicts, state });
  } else {
    print({ ok: false, error: "usage: bot-computer-netguard.mjs arm PORT TARGET TTL | disarm ID GRACE" });
    process.exit(2);
  }
  process.exit(0);
} catch (error) {
  print({ ok: false, step: command, error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
}
`;
