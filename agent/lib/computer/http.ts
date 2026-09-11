import { posix } from "node:path";

import type { Access } from "../access";
import { record } from "../activity";
import { getBot } from "../bots";
import { posterKey, readScreen } from "../screens";
import { computerControl } from "./control";
import { computerKey } from "./keys";
import {
  captureScreen,
  ComputerError,
  ensureScreen,
  isInstalling,
  listDirectory,
  MAX_FILE_BYTES,
  openUrl,
  readWorkspaceFile,
  removeWorkspacePath,
  saveTabs,
  sendInput,
  syncIdentity,
  writeWorkspaceFile,
  type ComputerIo,
  type InputEvent,
} from "./runtime";
import {
  allocateScreen,
  liveControl,
  screenForBot,
  setBrowserState,
  setControl,
  setHandoverNote,
  touchScreen,
  type ScreenAllocation,
  type ScreenControl,
} from "./screens";
import { mintToken, type ComputerAccess } from "./tokens";

/**
 * The console's computer routes: a Bot's live browser and its still frame,
 * taking control and handing it back, and the Files drawer.
 *
 * Every handler here runs after the ops channel authenticated the caller, and
 * scopes Bots to the caller's workspace. Live connections go straight from the
 * browser to the computer's gateway with a token minted here.
 */

const SECURITY_HEADERS = { "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...SECURITY_HEADERS },
  });

/** Control lapses this long after the console's last heartbeat. */
const CONTROL_LEASE_MS = 90_000;
/** Nobody holds a Bot's browser longer than this in one go. */
const CONTROL_MAX_MS = Number(process.env.BOT_COMPUTER_CONTROL_MINUTES ?? 30) * 60_000;
/** How long a request waits on the computer before answering "starting". */
const START_WAIT_MS = 20_000;

type Outcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly response: Response };

const starting = (detail: string) => json({ mode: "starting", retryAfterMs: 4_000, detail }, 202);
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Runs `work` against the computer, waking it if needed, and maps failures to responses. */
async function withComputer<T>(work: (io: ComputerIo) => Promise<T>, waitMs = START_WAIT_MS): Promise<Outcome<T>> {
  const control = computerControl();
  const availability = await control.availability();
  if (availability.state === "unavailable") {
    return { ok: false, response: json({ mode: "unavailable", error: availability.error }, 502) };
  }
  const missing = {
    ok: false as const,
    response: json(
      {
        mode: "unavailable",
        error: "The team's computer starts with the first job a Bot runs. Ask a Bot to do something, then open it again.",
      },
      409,
    ),
  };
  if (availability.state === "missing") return missing;
  try {
    const io = await control.io();
    if (io === null) return missing;
    const pending = work(io);
    const winner = await Promise.race([
      pending.then((value) => ({ value })),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), waitMs)),
    ]);
    if (winner === null) {
      pending.catch(() => undefined);
      return { ok: false, response: starting("The computer is waking up.") };
    }
    return { ok: true, value: winner.value };
  } catch (error) {
    if (isInstalling(error)) return { ok: false, response: starting(message(error)) };
    if (error instanceof ComputerError && error.step === "files") {
      return { ok: false, response: json({ error: error.message }, /does not exist/.test(error.message) ? 404 : 400) };
    }
    return { ok: false, response: json({ mode: "unavailable", error: message(error) }, 502) };
  }
}

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    return body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function botFor(access: Access, botId: string | undefined) {
  return botId === undefined || botId === "" ? null : getBot(access.workspaceId, botId);
}

const noBot = () => json({ error: "no such bot" }, 404);
const heldBy = (control: ScreenControl) => json({ error: `${control.by} has control of this browser right now.` }, 409);

/** A connection to one Bot's browser: a gateway URL, or relay URLs when live connections are unavailable. */
async function connection(
  botId: string,
  screen: ScreenAllocation,
  access: ComputerAccess,
  options: { keepAlive?: boolean } = {},
): Promise<Response> {
  const computer = computerControl();
  let gateway: string | null;
  try {
    gateway = await computer.gatewayUrl();
  } catch (error) {
    return json({ mode: "unavailable", error: message(error) }, 502);
  }
  if (options.keepAlive !== false) await computer.keepAlive().catch(() => undefined);
  const control = liveControl(screen);
  const shared = {
    screen: screen.n,
    viewOnly: access === "view",
    control: control === null ? null : { by: control.by, until: control.until },
  };
  if (gateway === null) {
    return json({
      mode: "relay",
      ...shared,
      frameUrl: `/bot/v1/bots/${botId}/computer/frame`,
      inputUrl: `/bot/v1/bots/${botId}/computer/input`,
    });
  }
  const token = mintToken(await computerKey(), { n: screen.n, target: "browser", access });
  return json({ mode: "vnc", ...shared, url: gateway + token });
}

/** Watch a Bot's browser live. Starts its screen, and the computer, if needed. */
export async function openBrowser(request: Request, access: Access, botId: string | undefined): Promise<Response> {
  const bot = await botFor(access, botId);
  if (bot === null) return noBot();
  const body = await readBody(request);
  if (body?.wake === false) return watchBrowser(access, bot.id);
  const screen = await allocateScreen(access.workspaceId, bot.id);
  const control = liveControl(screen);
  const wantsControl = body?.access === "control";
  if (wantsControl && control?.by !== access.user) {
    return control === null ? json({ error: "Take control first." }, 409) : heldBy(control);
  }
  const started = await withComputer((io) => ensureScreen(io, screen.n, { wait: false }));
  if (!started.ok) return started.response;
  if (started.value.started || screen.browser.state !== "on") await setBrowserState(screen.n, "on");
  return connection(bot.id, screen, wantsControl ? "control" : "view");
}

/**
 * A glance at a Bot's browser, for the thumbnail in its panel: live while the
 * browser is already running, and never a reason to start it, wake the
 * computer, or keep either from going idle. Anything else is `asleep`, and the
 * console shows the last still frame.
 */
async function watchBrowser(access: Access, botId: string): Promise<Response> {
  const screen = await screenForBot(access.workspaceId, botId);
  if (screen === null || screen.browser.state !== "on") return json({ mode: "asleep" });
  if ((await computerControl().availability()).state !== "running") return json({ mode: "asleep" });
  return connection(botId, screen, "view", { keepAlive: false });
}

/** Take control of a Bot's browser. The Bot's browser tools wait until it is released. */
export async function takeControl(request: Request, access: Access, botId: string | undefined): Promise<Response> {
  const bot = await botFor(access, botId);
  if (bot === null) return noBot();
  const body = await readBody(request);
  const requestId =
    typeof body?.requestId === "string" && /^[\w.:-]{1,200}$/.test(body.requestId) ? body.requestId : null;
  const screen = await allocateScreen(access.workspaceId, bot.id);
  const current = liveControl(screen);
  if (current !== null && current.by !== access.user) return heldBy(current);

  const now = Date.now();
  await setControl(screen.n, {
    by: access.user,
    since: current?.since ?? new Date(now).toISOString(),
    until: new Date(now + CONTROL_LEASE_MS).toISOString(),
    requestId: requestId ?? current?.requestId ?? null,
  });
  if (current === null) {
    await record({
      workspaceId: access.workspaceId,
      kind: "computer.takeover",
      botId: bot.id,
      text: `${access.user} took control of ${bot.name}'s browser.`,
    });
  }
  const started = await withComputer((io) => ensureScreen(io, screen.n, { wait: false }));
  if (!started.ok) return started.response;
  const url = screen.handover?.url ?? null;
  if (started.value.started && url !== null) {
    // The browser restarted since the Bot asked. It reopens its last tabs; only
    // if it came back empty does the page the Bot was on get opened.
    await withComputer((io) => openUrl(io, screen.n, url, { ifBlank: true }));
  }
  const held = (await screenForBot(access.workspaceId, bot.id)) ?? screen;
  return connection(bot.id, held, "control");
}

/**
 * Someone has the Bot's computer open. Watching counts as use, so the idle
 * reaper never stops a screen under a person looking at it, and the computer
 * stays awake while they do. Never starts anything.
 */
export async function keepWatching(access: Access, botId: string | undefined): Promise<Response> {
  const bot = await botFor(access, botId);
  if (bot === null) return noBot();
  const screen = await screenForBot(access.workspaceId, bot.id);
  if (screen === null) return json({ watching: false });
  await touchScreen(screen.n);
  await computerControl().keepAlive().catch(() => undefined);
  return json({ watching: true });
}

/** Keeps control while the operator is still at it, and keeps the computer awake. */
export async function renewControl(access: Access, botId: string | undefined): Promise<Response> {
  const bot = await botFor(access, botId);
  if (bot === null) return noBot();
  const screen = await screenForBot(access.workspaceId, bot.id);
  const current = screen === null ? null : liveControl(screen);
  if (screen === null || current === null || current.by !== access.user) {
    return json({ error: "You do not have control of this browser." }, 409);
  }
  const until = Math.min(Date.now() + CONTROL_LEASE_MS, Date.parse(current.since) + CONTROL_MAX_MS);
  if (until <= Date.now()) {
    await setControl(screen.n, null);
    return json({ error: "Control timed out. Take control again if you still need it." }, 409);
  }
  await setControl(screen.n, { ...current, until: new Date(until).toISOString() });
  await computerControl().keepAlive().catch(() => undefined);
  return json({ until: new Date(until).toISOString() });
}

/**
 * Gives control back. Handing back also shares whatever the operator signed in
 * to with every other browser on the computer; the console then answers the
 * Bot's takeover request so it carries on.
 */
export async function releaseControl(
  access: Access,
  botId: string | undefined,
  options: { handBack: boolean; request?: Request },
): Promise<Response> {
  const bot = await botFor(access, botId);
  if (bot === null) return noBot();
  const screen = await screenForBot(access.workspaceId, bot.id);
  const current = screen === null ? null : liveControl(screen);
  const body = options.request === undefined ? null : await readBody(options.request);
  const note = typeof body?.note === "string" && body.note.trim() !== "" ? body.note.trim().slice(0, 1_000) : null;
  // What the person did goes to the Bot when it resumes, whether or not they still hold control.
  if (options.handBack && screen !== null && note !== null) await setHandoverNote(screen.n, note);
  const handover = screen?.handover ?? null;
  if (screen === null || current === null) {
    return json({ released: true, synced: 0, requestId: handover?.requestId ?? null, room: handover?.room ?? null });
  }
  if (current.by !== access.user) return heldBy(current);

  let synced = 0;
  if (options.handBack) {
    const outcome = await withComputer((io) => syncIdentity(io, screen.n), 45_000);
    if (outcome.ok) synced = outcome.value.synced;
  }
  // Wherever the person left the browser is where it reopens after a restart.
  await withComputer((io) => saveTabs(io, screen.n), 20_000);
  await setControl(screen.n, null);
  if (options.handBack) {
    await record({
      workspaceId: access.workspaceId,
      kind: "computer.handback",
      botId: bot.id,
      text: `${access.user} handed ${bot.name}'s browser back.`,
    });
  }
  return json({
    released: true,
    synced,
    requestId: current.requestId ?? handover?.requestId ?? null,
    room: handover?.room ?? null,
  });
}

/** The still frame of a Bot's screen, refreshed as it works. Never wakes the computer. */
export async function poster(access: Access, botId: string | undefined): Promise<Response> {
  const bot = await botFor(access, botId);
  if (bot === null) return noBot();
  const frame = await readScreen(access.workspaceId, posterKey(bot.id));
  if (frame === null) return json({ error: "no screen" }, 404);
  return new Response(Buffer.from(frame.base64, "base64"), {
    headers: { "content-type": frame.mediaType, "cache-control": "no-store", "x-screen-at": frame.at, ...SECURITY_HEADERS },
  });
}

/** A fresh frame from a Bot's browser, for backends without live connections. */
export async function frame(access: Access, botId: string | undefined): Promise<Response> {
  const bot = await botFor(access, botId);
  if (bot === null) return noBot();
  const screen = await screenForBot(access.workspaceId, bot.id);
  if (screen === null) return json({ error: "no screen" }, 404);
  const outcome = await withComputer((io) => captureScreen(io, screen.n, 50));
  if (!outcome.ok) return outcome.response;
  return new Response(Buffer.from(outcome.value.bytes), {
    headers: { "content-type": outcome.value.mediaType, "cache-control": "no-store", ...SECURITY_HEADERS },
  });
}

/** Relayed mouse and keyboard input. Only the person holding control may send it. */
export async function input(request: Request, access: Access, botId: string | undefined): Promise<Response> {
  const bot = await botFor(access, botId);
  if (bot === null) return noBot();
  const screen = await screenForBot(access.workspaceId, bot.id);
  const current = screen === null ? null : liveControl(screen);
  if (screen === null || current === null || current.by !== access.user) {
    return json({ error: "Take control first." }, 409);
  }
  const event = inputEvent(await readBody(request));
  if (event === null) return json({ error: "unsupported input" }, 400);
  const outcome = await withComputer((io) => sendInput(io, screen.n, event));
  return outcome.ok ? json({ ok: true }) : outcome.response;
}

function inputEvent(body: Record<string, unknown> | null): InputEvent | null {
  const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null);
  const x = number(body?.x);
  const y = number(body?.y);
  switch (body?.type) {
    case "click": {
      if (x === null || y === null) return null;
      const button = body.button === "right" || body.button === "middle" ? body.button : "left";
      return { type: "click", x, y, button, clicks: Math.min(3, Math.max(1, number(body.clicks) ?? 1)) };
    }
    case "move":
      return x === null || y === null ? null : { type: "move", x, y };
    case "scroll": {
      const dy = number(body.dy);
      return x === null || y === null || dy === null ? null : { type: "scroll", x, y, dy };
    }
    case "type":
      return typeof body.text === "string" && body.text.length <= 4_000 ? { type: "type", text: body.text } : null;
    case "key":
      return typeof body.key === "string" && /^[A-Za-z0-9_+]{1,48}$/.test(body.key) ? { type: "key", key: body.key } : null;
    default:
      return null;
  }
}

const pathParam = (request: Request) => new URL(request.url).searchParams.get("path") ?? "/workspace";

export async function listFiles(request: Request): Promise<Response> {
  const outcome = await withComputer((io) => listDirectory(io, pathParam(request)), 45_000);
  return outcome.ok ? json(outcome.value) : outcome.response;
}

const TEXT_TYPES = new Set([
  ".txt", ".md", ".csv", ".tsv", ".json", ".log", ".yml", ".yaml", ".toml", ".xml", ".html", ".css",
  ".js", ".mjs", ".ts", ".tsx", ".py", ".sh", ".sql", ".env", ".ini",
]);
const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/**
 * A file's contents. Text and plain images may be previewed; everything is served
 * sandboxed, because Bots save whatever they find on the web.
 */
export async function fileContent(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const outcome = await withComputer((io) => readWorkspaceFile(io, pathParam(request)), 45_000);
  if (!outcome.ok) return outcome.response;
  const { path, bytes } = outcome.value;
  const extension = posix.extname(path).toLowerCase();
  const download = url.searchParams.get("download") === "1";
  const type = IMAGE_TYPES[extension] ?? (TEXT_TYPES.has(extension) ? "text/plain; charset=utf-8" : "application/octet-stream");
  const inline = !download && type !== "application/octet-stream";
  return new Response(Buffer.from(bytes), {
    headers: {
      "content-type": type,
      "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(posix.basename(path))}`,
      "content-security-policy": "sandbox",
      "cache-control": "no-store",
      ...SECURITY_HEADERS,
    },
  });
}

export async function uploadFile(request: Request, access: Access): Promise<Response> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_FILE_BYTES) return json({ error: `Uploads are limited to ${MAX_FILE_BYTES / 1_048_576} MB.` }, 413);
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_FILE_BYTES) return json({ error: `Uploads are limited to ${MAX_FILE_BYTES / 1_048_576} MB.` }, 413);
  const outcome = await withComputer((io) => writeWorkspaceFile(io, pathParam(request), bytes), 60_000);
  if (!outcome.ok) return outcome.response;
  console.info(`[computer] ${access.user} uploaded ${outcome.value.path} (${bytes.byteLength} bytes)`);
  return json({ saved: true, path: outcome.value.path, bytes: bytes.byteLength }, 201);
}

/** Deletes need the item's name typed back, so a stray click cannot remove a Bot's work. */
export async function deleteFile(request: Request, access: Access): Promise<Response> {
  const path = pathParam(request);
  const body = await readBody(request);
  if (typeof body?.confirm !== "string" || body.confirm !== posix.basename(path)) {
    return json({ error: "Type the name of the file or folder to confirm." }, 400);
  }
  const outcome = await withComputer((io) => removeWorkspacePath(io, path), 60_000);
  if (!outcome.ok) return outcome.response;
  console.info(`[computer] ${access.user} deleted ${outcome.value.path}`);
  return json({ deleted: true, path: outcome.value.path });
}
