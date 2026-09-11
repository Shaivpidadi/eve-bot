import { Sandbox as VercelSandbox } from "@vercel/sandbox";

import { COMPUTER_NAME } from "../computer";
import { COMPUTER_PORT, computerMode, vercelCredentialsError, type ComputerMode } from "../computer-config";
import type { ComputerIo } from "./runtime";

/**
 * The console's handle on the team's computer.
 *
 * Bots reach the computer through eve's sandbox handle, but console routes run
 * outside any session, so they find the same machine through the provider
 * directly. Asking whether it is up never wakes it; opening a screen, a
 * terminal, or a file does.
 */
export type Availability =
  | { readonly state: "running" }
  /** It exists and resumes, with its files, on the next use. */
  | { readonly state: "stopped" }
  /** Not created yet: the computer starts with the first job a Bot runs. */
  | { readonly state: "missing" }
  | { readonly state: "unavailable"; readonly error: string };

export interface ComputerControl {
  readonly backend: ComputerMode;
  availability(): Promise<Availability>;
  /** Commands and files on the computer, waking it if needed; null if it does not exist yet. */
  io(): Promise<ComputerIo | null>;
  /**
   * The gateway's WebSocket address, ending in `?token=`. Null when this backend
   * cannot take live connections, in which case the console relays frames.
   */
  gatewayUrl(): Promise<string | null>;
  /** Keeps a computer someone is looking at from idling out. */
  keepAlive(): Promise<void>;
}

let control: ComputerControl | null = null;

export function computerControl(): ComputerControl {
  control ??= computerMode() === "vercel" ? vercelControl() : localControl();
  return control;
}

const SANDBOX_CACHE_MS = 30_000;
const KEEP_ALIVE_EVERY_MS = 50_000;
const KEEP_ALIVE_BY_MS = 60_000;

function vercelControl(): ComputerControl {
  let cached: { sandbox: VercelSandbox | null; at: number } | null = null;
  let lastKeepAlive = 0;
  const ios = new WeakMap<VercelSandbox, ComputerIo>();

  async function sandbox(): Promise<VercelSandbox | null> {
    if (cached !== null && Date.now() - cached.at < SANDBOX_CACHE_MS) return cached.sandbox;
    const problem = vercelCredentialsError();
    if (problem !== null) throw new Error(problem);
    try {
      cached = { sandbox: await VercelSandbox.get({ name: COMPUTER_NAME }), at: Date.now() };
    } catch (error) {
      if (!notFound(error)) throw error;
      cached = { sandbox: null, at: Date.now() };
    }
    return cached.sandbox;
  }

  return {
    backend: "vercel",
    async availability() {
      try {
        const found = await sandbox();
        if (found === null) return { state: "missing" };
        return found.status === "running" ? { state: "running" } : { state: "stopped" };
      } catch (error) {
        return { state: "unavailable", error: message(error) };
      }
    },
    async io() {
      const found = await sandbox();
      if (found === null) return null;
      let io = ios.get(found);
      if (io === undefined) {
        io = vercelIo(found);
        ios.set(found, io);
      }
      return io;
    },
    async gatewayUrl() {
      const found = await sandbox();
      if (found === null) return null;
      const exposed = gatewayOf(found);
      if (exposed !== null) return exposed;
      // A computer created before the gateway existed: expose its port now.
      await found.update({ ports: [COMPUTER_PORT] });
      cached = null;
      const refreshed = await sandbox();
      const url = refreshed === null ? null : gatewayOf(refreshed);
      if (url === null) throw new Error("The computer's gateway port could not be exposed.");
      return url;
    },
    async keepAlive() {
      if (Date.now() - lastKeepAlive < KEEP_ALIVE_EVERY_MS) return;
      lastKeepAlive = Date.now();
      const found = await sandbox();
      if (found?.status === "running") await found.extendTimeout(KEEP_ALIVE_BY_MS).catch(() => undefined);
    },
  };
}

function gatewayOf(sandbox: VercelSandbox): string | null {
  try {
    return `${sandbox.domain(COMPUTER_PORT).replace(/^https:/, "wss:").replace(/\/$/, "")}/websockify?token=`;
  } catch {
    return null;
  }
}

function vercelIo(sandbox: VercelSandbox): ComputerIo {
  return {
    async run(command, options = {}) {
      const done = await sandbox.runCommand({
        cmd: "bash",
        args: ["-lc", command],
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      });
      const [stdout, stderr] = await Promise.all([done.stdout(), done.stderr()]);
      return { exitCode: done.exitCode, stdout, stderr };
    },
    async readBinaryFile(path) {
      const buffer = await sandbox.readFileToBuffer({ path });
      return buffer === null ? null : new Uint8Array(buffer);
    },
    async writeBinaryFile(path, content) {
      await sandbox.writeFiles([{ path, content }]);
    },
  };
}

/**
 * A computer in a VM on this machine. Console access to it arrives with the
 * local relay; until then the console says so instead of failing obscurely.
 */
function localControl(): ComputerControl {
  const unavailable = "Live view of a local computer is not available yet. Unset BOT_COMPUTER to use Vercel Sandbox.";
  return {
    backend: "local",
    availability: async () => ({ state: "unavailable", error: unavailable }),
    io: async () => null,
    gatewayUrl: async () => null,
    keepAlive: async () => undefined,
  };
}

function notFound(error: unknown): boolean {
  const status = (error as { response?: { status?: number } } | null)?.response?.status;
  return status === 404 || /\b404\b|not found/i.test(message(error));
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
