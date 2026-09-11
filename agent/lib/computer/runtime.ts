import { createHash } from "node:crypto";
import { posix } from "node:path";

import type { SandboxSession } from "eve/sandbox";
import type { ToolContext } from "eve/tools";

import { computerKey } from "./keys";
import {
  COMPUTER_BIN,
  COMPUTER_HOME,
  COMPUTER_KEY_PATH,
  COMPUTER_SCRIPT,
  COMPUTER_VERSION_PATH,
  computerRuntime,
  type ComputerRuntime,
} from "./script";

/**
 * Operating the team's computer: its screens, sign-ins and files.
 *
 * Everything goes through `ComputerIo`, so the same code serves Bots (through
 * eve's sandbox handle) and console routes (through the sandbox provider's SDK,
 * see `control.ts`). Calls are idempotent: a computer that was stopped, resumed
 * from a snapshot, or replaced gets its software and services back on the next
 * call that needs them.
 */

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ComputerIo {
  run(command: string, options?: { timeoutMs?: number }): Promise<CommandResult>;
  readBinaryFile(path: string): Promise<Uint8Array | null>;
  writeBinaryFile(path: string, content: Uint8Array): Promise<void>;
}

type Sandbox = Pick<SandboxSession, "run" | "readBinaryFile" | "writeBinaryFile">;

export function sandboxIo(sandbox: Sandbox, abortSignal?: AbortSignal): ComputerIo {
  return {
    async run(command, options = {}) {
      const signals = [abortSignal, options.timeoutMs === undefined ? undefined : AbortSignal.timeout(options.timeoutMs)]
        .filter((signal): signal is AbortSignal => signal !== undefined);
      const result = await sandbox.run({
        command,
        ...(signals.length === 0 ? {} : { abortSignal: AbortSignal.any(signals) }),
      });
      return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
    },
    async readBinaryFile(path) {
      return (await sandbox.readBinaryFile({ path })) ?? null;
    },
    async writeBinaryFile(path, content) {
      await sandbox.writeBinaryFile({ path, content });
    },
  };
}

export async function toolIo(ctx: ToolContext): Promise<ComputerIo> {
  return sandboxIo(await ctx.getSandbox(), ctx.abortSignal);
}

export class ComputerError extends Error {
  constructor(
    message: string,
    readonly step: string,
  ) {
    super(message);
    this.name = "ComputerError";
  }
}

let runtime: ComputerRuntime | null = null;

function currentRuntime(): ComputerRuntime {
  const flags = [process.env.BOT_COMPUTER_CHROME_FLAGS ?? ""];
  if (process.env.BOT_BROWSER_PROXY) flags.push(`--proxy-server=${process.env.BOT_BROWSER_PROXY}`);
  runtime ??= computerRuntime({ chromeFlags: flags.join(" "), aptMirror: process.env.BOT_COMPUTER_APT_MIRROR });
  return runtime;
}

/** How long a process trusts that the computer has the current runtime. */
const RUNTIME_TRUSTED_MS = 60_000;
const verified = new WeakMap<ComputerIo, number>();
const installing = new WeakMap<ComputerIo, Promise<void>>();

/** Writes the runtime and access key onto the computer unless they are already current. */
export async function ensureRuntime(io: ComputerIo): Promise<void> {
  if (Date.now() - (verified.get(io) ?? 0) < RUNTIME_TRUSTED_MS) return;
  let pending = installing.get(io);
  if (pending === undefined) {
    pending = writeRuntime(io).finally(() => installing.delete(io));
    installing.set(io, pending);
  }
  await pending;
}

async function writeRuntime(io: ComputerIo): Promise<void> {
  const current = currentRuntime();
  const key = await computerKey();
  const stamp = `${current.version}:${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
  const installed = await io.run(`cat ${COMPUTER_VERSION_PATH} 2>/dev/null || true`, { timeoutMs: 30_000 });
  if (installed.stdout.trim() !== stamp) {
    const prepared = await io.run(`mkdir -p ${folders(current)} && chmod 700 ${COMPUTER_HOME}`, { timeoutMs: 30_000 });
    if (prepared.exitCode !== 0) {
      throw new ComputerError(`Could not prepare the computer: ${tail(prepared)}`, "prepare");
    }
    const encoder = new TextEncoder();
    for (const file of current.files) await io.writeBinaryFile(file.path, encoder.encode(file.content));
    await io.writeBinaryFile(COMPUTER_KEY_PATH, encoder.encode(key));
    const modes = current.files.map((file) => `chmod ${file.mode.toString(8)} ${file.path}`);
    const finished = await io.run(
      [...modes, `chmod 600 ${COMPUTER_KEY_PATH}`, `printf '%s' '${stamp}' > ${COMPUTER_VERSION_PATH}`].join(" && "),
      { timeoutMs: 30_000 },
    );
    if (finished.exitCode !== 0) {
      throw new ComputerError(`Could not install the computer's runtime: ${tail(finished)}`, "prepare");
    }
    // Screens already running pick up new desktop settings without restarting.
    await io.run(`${COMPUTER_SCRIPT} reload`, { timeoutMs: 30_000 }).catch(() => undefined);
  }
  verified.set(io, Date.now());
}

/**
 * Installs the computer's software without its access key, for sandbox
 * templates built before any app store is reachable. The first real use then
 * adds the key.
 */
export async function installSoftware(io: ComputerIo): Promise<void> {
  const current = currentRuntime();
  const prepared = await io.run(`mkdir -p ${folders(current)} && chmod 700 ${COMPUTER_HOME}`, { timeoutMs: 30_000 });
  if (prepared.exitCode !== 0) throw new ComputerError(`Could not prepare the computer: ${tail(prepared)}`, "prepare");
  const encoder = new TextEncoder();
  for (const file of current.files) await io.writeBinaryFile(file.path, encoder.encode(file.content));
  const modes = await io.run(current.files.map((file) => `chmod ${file.mode.toString(8)} ${file.path}`).join(" && "), {
    timeoutMs: 30_000,
  });
  if (modes.exitCode !== 0) throw new ComputerError(`Could not prepare the computer: ${tail(modes)}`, "prepare");
  await untilInstalled(async () => {
    const result = await io.run(`${COMPUTER_SCRIPT} install`, { timeoutMs: CALL_TIMEOUT_MS });
    const answer = lastJson<ScriptAnswer>(result.stdout);
    if (answer?.ok !== true) {
      throw new ComputerError(answer?.error ?? `Installing the computer's software failed: ${tail(result)}`, answer?.step ?? "install");
    }
  });
}

/** Every folder the runtime's files live in. */
const folders = (current: ComputerRuntime) =>
  [...new Set(current.files.map((file) => posix.dirname(file.path)))].map(shellQuote).join(" ");

export function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

interface ScriptAnswer {
  readonly ok: boolean;
  readonly error?: string;
  readonly step?: string;
}

async function runScript<T>(io: ComputerIo, args: readonly string[], timeoutMs: number): Promise<T> {
  await ensureRuntime(io);
  const command = [COMPUTER_SCRIPT, ...args].map(shellQuote).join(" ");
  let result = await io.run(command, { timeoutMs });
  if (result.exitCode === 126 || result.exitCode === 127) {
    // The computer was replaced or wiped since this process last checked.
    verified.delete(io);
    await ensureRuntime(io);
    result = await io.run(command, { timeoutMs });
  }
  const answer = lastJson<ScriptAnswer>(result.stdout);
  if (answer === null) {
    throw new ComputerError(`The computer gave no answer to "${args[0]}": ${tail(result)}`, args[0] ?? "");
  }
  if (!answer.ok) throw new ComputerError(answer.error ?? "Unknown error.", answer.step ?? args[0] ?? "");
  return answer as T;
}

function lastJson<T>(stdout: string): T | null {
  const lines = stdout.trim().split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim() ?? "";
    if (!line.startsWith("{")) continue;
    try {
      return JSON.parse(line) as T;
    } catch {
      return null;
    }
  }
  return null;
}

const tail = (result: CommandResult) => (result.stderr.trim() || result.stdout.trim()).slice(-400) || `exit ${result.exitCode}`;

/**
 * No single command may run long: the provider drops a command's connection
 * after a few minutes. The first-time install therefore runs in the background
 * on the computer, and calls report "installing" until it is done.
 */
const CALL_TIMEOUT_MS = 3 * 60_000;
/** Installing the browser on a fresh computer takes a few minutes. */
const INSTALL_DEADLINE_MS = 20 * 60_000;
const INSTALL_POLL_MS = 5_000;

/** The computer is installing its software for the first time; try again shortly. */
export const isInstalling = (error: unknown): boolean => error instanceof ComputerError && error.step === "installing";

async function untilInstalled<T>(attempt: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + INSTALL_DEADLINE_MS;
  for (;;) {
    try {
      return await attempt();
    } catch (error) {
      if (!isInstalling(error) || Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, INSTALL_POLL_MS));
    }
  }
}

export interface ScreenStarted {
  readonly screen: number;
  readonly display: string;
  readonly vnc: number;
  readonly cdp: number;
  /** False when the screen was already running. */
  readonly started: boolean;
  readonly ms: number;
}

/**
 * Starts a screen's display and browser. By default waits out a first-time
 * install; console routes pass `wait: false` and show "starting" instead.
 */
export function ensureScreen(io: ComputerIo, n: number, options: { wait?: boolean } = {}): Promise<ScreenStarted> {
  const attempt = () => runScript<ScreenStarted>(io, ["ensure", String(n)], CALL_TIMEOUT_MS);
  return options.wait === false ? attempt() : untilInstalled(attempt);
}

export function stopScreen(io: ComputerIo, n: number): Promise<void> {
  return runScript(io, ["stop", String(n)], 60_000);
}

export function recoverComputer(io: ComputerIo): Promise<void> {
  return runScript(io, ["recover"], 120_000);
}

export interface ComputerStatus {
  readonly version: string;
  readonly installed: boolean;
  readonly gateway: boolean;
  readonly screens: readonly { screen: number; display: boolean; browser: boolean; desktop: boolean }[];
}

export function computerStatus(io: ComputerIo): Promise<ComputerStatus> {
  return runScript<ComputerStatus>(io, ["status"], 30_000);
}

export interface ScreenCapture {
  readonly bytes: Uint8Array;
  readonly mediaType: "image/jpeg";
  readonly url: string;
  readonly title: string;
}

/** What the screen's browser is showing, as a JPEG. */
export async function captureScreen(
  io: ComputerIo,
  n: number,
  quality = 60,
  targetId?: string,
): Promise<ScreenCapture> {
  const path = `/tmp/bot-computer/shot-${n}.jpg`;
  const answer = await runScript<{ url: string; title: string }>(
    io,
    ["shot", String(n), path, String(quality), ...(targetId === undefined ? [] : [targetId])],
    30_000,
  );
  const bytes = await io.readBinaryFile(path);
  if (bytes === null) throw new ComputerError("The screenshot was not written.", "shot");
  return { bytes, mediaType: "image/jpeg", url: answer.url, title: answer.title };
}

export type InputEvent =
  | { readonly type: "click"; readonly x: number; readonly y: number; readonly button?: "left" | "middle" | "right"; readonly clicks?: number }
  | { readonly type: "move"; readonly x: number; readonly y: number }
  | { readonly type: "scroll"; readonly x: number; readonly y: number; readonly dy: number }
  | { readonly type: "type"; readonly text: string }
  | { readonly type: "key"; readonly key: string };

export function sendInput(io: ComputerIo, n: number, event: InputEvent): Promise<void> {
  return runScript(io, ["input", String(n), JSON.stringify(event)], 45_000);
}

/** Brings the screen's browser to the front, in case someone left another window over it. */
export function raiseBrowser(io: ComputerIo, n: number): Promise<void> {
  return runScript(io, ["raise", String(n)], 30_000);
}

/** Brings one Bot's tab to the front of the shared browser window. */
export function activateTab(io: ComputerIo, n: number, targetId: string): Promise<{ ok: boolean }> {
  return runScript(io, ["activate", String(n), targetId], 15_000);
}

/** Closes one Bot's tab, for when its job is done. Never fails the caller. */
export function closeTab(io: ComputerIo, n: number, targetId: string): Promise<{ ok: boolean; closed?: boolean }> {
  return runScript(io, ["close-tab", String(n), targetId], 15_000);
}

/** Points the screen's browser at a web address. */
/** Opens a page on a screen's browser. `ifBlank` leaves a page that is already on screen alone. */
export function openUrl(io: ComputerIo, n: number, url: string, options: { ifBlank?: boolean } = {}): Promise<void> {
  if (!/^https?:\/\/[^\s]+$/i.test(url)) return Promise.reject(new ComputerError("Only web addresses can be opened.", "open"));
  return runScript(io, ["open", String(n), url, ...(options.ifBlank ? ["if-blank"] : [])], 45_000);
}

/** Notes a screen's open tabs, so a browser that restarts without them reopens them. */
export function saveTabs(io: ComputerIo, n: number): Promise<{ saved: number }> {
  return runScript(io, ["tabs", "save", String(n)], 30_000);
}

/** Copies this screen's sign-ins into the team's jar and into every other running browser. */
export function syncIdentity(io: ComputerIo, n: number): Promise<{ synced: number }> {
  return runScript(io, ["identity", "sync", String(n)], 60_000);
}

/** Saves this screen's sign-ins to the team's jar, which backups carry. */
export function exportIdentity(io: ComputerIo, n: number): Promise<{ cookies: number }> {
  return runScript(io, ["identity", "export", String(n)], 60_000);
}

// Files. The Files app sees `/workspace`, minus the computer's own internals
// (its access key, browser profiles, and saved sign-ins).

export const FILES_ROOT = "/workspace";
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

export interface FileEntry {
  readonly name: string;
  readonly path: string;
  readonly kind: "file" | "directory" | "link" | "other";
  readonly bytes: number;
  readonly modifiedAt: string;
}

/** Normalizes a Files path into an absolute path inside `/workspace`, or throws. */
export function workspacePath(input: string): string {
  const cleaned = input.replaceAll("\0", "").trim();
  const absolute = posix.normalize(posix.join(FILES_ROOT, cleaned.startsWith(FILES_ROOT) ? cleaned.slice(FILES_ROOT.length) : cleaned));
  if (absolute !== FILES_ROOT && !absolute.startsWith(`${FILES_ROOT}/`)) {
    throw new ComputerError("That path is outside the computer's workspace.", "files");
  }
  if (absolute === COMPUTER_HOME || absolute.startsWith(`${COMPUTER_HOME}/`)) {
    throw new ComputerError("That folder belongs to the computer itself.", "files");
  }
  return absolute;
}

/**
 * A shell guard that resolves symlinks and refuses anything that lands outside
 * the workspace or inside the computer's internals. Leaves the resolved path in $p.
 */
function confine(path: string): string {
  return [
    `p=$(realpath -m -- ${shellQuote(path)})`,
    `case "$p" in ${COMPUTER_HOME}|${COMPUTER_HOME}/*) echo "internal" >&2; exit 3 ;; ${FILES_ROOT}|${FILES_ROOT}/*) ;; *) echo "outside" >&2; exit 3 ;; esac`,
  ].join("\n");
}

async function guarded(io: ComputerIo, path: string, body: string, timeoutMs = 30_000): Promise<CommandResult> {
  const result = await io.run(`${confine(path)}\n${body}`, { timeoutMs });
  if (result.exitCode === 3) {
    throw new ComputerError("That path is outside the computer's workspace.", "files");
  }
  return result;
}

const KINDS: Record<string, FileEntry["kind"]> = { f: "file", d: "directory", l: "link" };

export async function listDirectory(io: ComputerIo, input: string): Promise<{ path: string; entries: FileEntry[]; truncated: boolean }> {
  const path = workspacePath(input);
  const limit = 1000;
  const result = await guarded(
    io,
    path,
    `[ -d "$p" ] || { echo "missing" >&2; exit 4; }\nfind "$p" -mindepth 1 -maxdepth 1 -printf '%y\\t%s\\t%T@\\t%f\\0' 2>/dev/null | head -z -n ${limit + 1}`,
  );
  if (result.exitCode === 4) throw new ComputerError("That folder does not exist.", "files");
  if (result.exitCode !== 0) throw new ComputerError(`Could not list ${path}: ${tail(result)}`, "files");
  const entries = result.stdout
    .split("\0")
    .filter((record) => record.length > 0)
    .map((record): FileEntry | null => {
      const [kind = "", bytes = "0", modified = "0", ...nameParts] = record.split("\t");
      const name = nameParts.join("\t");
      const full = posix.join(path, name);
      if (full === COMPUTER_HOME) return null;
      return {
        name,
        path: full,
        kind: KINDS[kind] ?? "other",
        bytes: Number(bytes),
        modifiedAt: new Date(Number(modified) * 1000).toISOString(),
      };
    })
    .filter((entry): entry is FileEntry => entry !== null);
  const sorted = entries
    .slice(0, limit)
    .sort((left, right) =>
      left.kind === right.kind ? left.name.localeCompare(right.name) : left.kind === "directory" ? -1 : right.kind === "directory" ? 1 : 0,
    );
  return { path, entries: sorted, truncated: entries.length > limit };
}

export async function readWorkspaceFile(io: ComputerIo, input: string): Promise<{ path: string; bytes: Uint8Array }> {
  const path = workspacePath(input);
  const result = await guarded(io, path, `[ -f "$p" ] || { echo "missing" >&2; exit 4; }\nstat -c '%s' -- "$p"\nprintf '%s' "$p" >&2`);
  if (result.exitCode === 4) throw new ComputerError("That file does not exist.", "files");
  if (result.exitCode !== 0) throw new ComputerError(`Could not open ${path}: ${tail(result)}`, "files");
  const size = Number(result.stdout.trim());
  if (!Number.isFinite(size) || size > MAX_FILE_BYTES) {
    throw new ComputerError(`That file is over the ${MAX_FILE_BYTES / 1_048_576} MB limit for the Files app.`, "files");
  }
  const resolved = result.stderr.trim() || path;
  const bytes = await io.readBinaryFile(resolved);
  if (bytes === null) throw new ComputerError("That file does not exist.", "files");
  return { path, bytes };
}

export async function writeWorkspaceFile(io: ComputerIo, input: string, bytes: Uint8Array): Promise<{ path: string }> {
  const path = workspacePath(input);
  if (path === FILES_ROOT) throw new ComputerError("Choose a file name.", "files");
  if (bytes.byteLength > MAX_FILE_BYTES) {
    throw new ComputerError(`Uploads are limited to ${MAX_FILE_BYTES / 1_048_576} MB.`, "files");
  }
  const result = await guarded(io, path, `[ -d "$p" ] && { echo "directory" >&2; exit 5; }\nmkdir -p -- "$(dirname -- "$p")"\nprintf '%s' "$p"`);
  if (result.exitCode === 5) throw new ComputerError("A folder already has that name.", "files");
  if (result.exitCode !== 0) throw new ComputerError(`Could not save ${path}: ${tail(result)}`, "files");
  await io.writeBinaryFile(result.stdout.trim() || path, bytes);
  return { path };
}

/** The folders the team's work is organised into; their contents can go, they cannot. */
const PROTECTED = new Set([FILES_ROOT, "/workspace/shared", "/workspace/bots", "/workspace/sessions", "/workspace/downloads"]);

export async function removeWorkspacePath(io: ComputerIo, input: string): Promise<{ path: string }> {
  const path = workspacePath(input);
  if (PROTECTED.has(path)) throw new ComputerError("That folder is part of the computer's layout and cannot be deleted.", "files");
  const protectedCase = [...PROTECTED].join("|");
  const result = await guarded(
    io,
    path,
    `case "$p" in ${protectedCase}) echo "protected" >&2; exit 5 ;; esac\n[ -e "$p" ] || [ -L "$p" ] || { echo "missing" >&2; exit 4; }\nrm -rf -- "$p"`,
    120_000,
  );
  if (result.exitCode === 4) throw new ComputerError("That path does not exist.", "files");
  if (result.exitCode === 5) throw new ComputerError("That folder is part of the computer's layout and cannot be deleted.", "files");
  if (result.exitCode !== 0) throw new ComputerError(`Could not delete ${path}: ${tail(result)}`, "files");
  return { path };
}
