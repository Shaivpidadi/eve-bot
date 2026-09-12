import { spawn } from "node:child_process";

import { Sandbox as VercelSandbox } from "@vercel/sandbox";

import { COMPUTER_NAME } from "../computer";
import { COMPUTER_PORT, computerMode, localComputer, vercelCredentialsError, type ComputerMode } from "../computer-config";
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
  control ??= computerMode() === "vercel" ? vercelControl() : localComputer() === "docker" ? dockerControl() : vmControl();
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
 * A computer in a microsandbox VM. The console cannot reach inside one yet, so
 * it says so instead of failing obscurely; Docker is the local backend it can.
 */
function vmControl(): ComputerControl {
  const unavailable =
    "The console cannot open a microsandbox computer yet. Set BOT_COMPUTER_LOCAL=docker to run the local computer in Docker, or unset BOT_COMPUTER to use Vercel Sandbox.";
  return {
    backend: "local",
    availability: async () => ({ state: "unavailable", error: unavailable }),
    io: async () => null,
    gatewayUrl: async () => null,
    keepAlive: async () => undefined,
  };
}

/** The computer's port for live connections, inside the container. */
const CONTAINER_GATEWAY_PORT = 6080;

/**
 * A computer in a Docker container on this machine (`BOT_COMPUTER=local`).
 *
 * eve runs the team's computer as a container named after it, and the console
 * reaches the same container through the Docker CLI. Live view needs the
 * computer's gateway on this machine, but eve publishes no ports, so a small
 * forwarder container on a private network publishes it on 127.0.0.1 only.
 * The gateway still admits nothing but single-use tokens, as on Vercel.
 */
function dockerControl(): ComputerControl {
  const cli = process.env.EVE_DOCKER_PATH?.trim() || "docker";
  const network = `${COMPUTER_NAME}-console`;
  const forwarder = `${COMPUTER_NAME}-gateway`;
  const hostPort = Number(process.env.BOT_COMPUTER_LOCAL_PORT ?? 16080);
  const forwarderImage = process.env.BOT_COMPUTER_FORWARDER_IMAGE?.trim() || "alpine/socat";
  let forwarding: Promise<void> | null = null;

  async function state(): Promise<"running" | "stopped" | "missing"> {
    const inspected = await docker(cli, ["container", "inspect", "--format", "{{.State.Running}}", COMPUTER_NAME]);
    if (inspected.exitCode !== 0) {
      if (/no such (object|container)/i.test(inspected.stderr)) return "missing";
      throw new Error(dockerProblem(inspected.stderr));
    }
    return inspected.stdout.toString("utf8").trim() === "true" ? "running" : "stopped";
  }

  /** Starts a stopped computer; false when there is none yet. */
  async function awake(): Promise<boolean> {
    const current = await state();
    if (current === "missing") return false;
    if (current === "stopped") expectDocker(await docker(cli, ["start", COMPUTER_NAME]), "start the computer");
    return true;
  }

  async function forward(): Promise<void> {
    if ((await docker(cli, ["network", "inspect", network])).exitCode !== 0) {
      const created = await docker(cli, ["network", "create", "--label", "eve-bot.console=1", network]);
      if (created.exitCode !== 0 && !/already exists/i.test(created.stderr)) expectDocker(created, "create the console network");
    }
    const networks = await docker(cli, ["container", "inspect", "--format", "{{json .NetworkSettings.Networks}}", COMPUTER_NAME]);
    if (!networks.stdout.toString("utf8").includes(`"${network}"`)) {
      const joined = await docker(cli, ["network", "connect", "--alias", COMPUTER_NAME, network, COMPUTER_NAME]);
      if (joined.exitCode !== 0 && !/already exists/i.test(joined.stderr)) {
        throw new Error(
          `The computer could not join ${network}: ${joined.stderr.trim()}. A local computer with networking turned off (BOT_SANDBOX_ALLOW_DOMAINS) cannot be watched live.`,
        );
      }
    }
    const running = await docker(cli, ["container", "inspect", "--format", "{{.State.Running}}", forwarder]);
    if (running.exitCode === 0 && running.stdout.toString("utf8").trim() === "true") return;
    await docker(cli, ["rm", "-f", forwarder]);
    expectDocker(
      await docker(
        cli,
        [
          "run", "-d", "--name", forwarder, "--label", "eve-bot.console=1", "--network", network,
          "--restart", "unless-stopped", "-p", `127.0.0.1:${hostPort}:${CONTAINER_GATEWAY_PORT}`,
          forwarderImage, `TCP-LISTEN:${CONTAINER_GATEWAY_PORT},fork,reuseaddr`, `TCP:${COMPUTER_NAME}:${CONTAINER_GATEWAY_PORT}`,
        ],
        { timeoutMs: 300_000 },
      ),
      "start the live-view forwarder",
    );
  }

  const io: ComputerIo = {
    async run(command, options = {}) {
      const result = await docker(cli, ["exec", "-w", "/workspace", COMPUTER_NAME, "bash", "-lc", command], {
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      });
      return { exitCode: result.exitCode, stdout: result.stdout.toString("utf8"), stderr: result.stderr };
    },
    async readBinaryFile(path) {
      const quoted = quote(path);
      const result = await docker(cli, ["exec", COMPUTER_NAME, "bash", "-lc", `if [ -e ${quoted} ]; then exec cat ${quoted}; else exit 43; fi`]);
      if (result.exitCode === 43) return null;
      expectDocker(result, `read ${path}`);
      return new Uint8Array(result.stdout);
    },
    async writeBinaryFile(path, content) {
      const folder = path.slice(0, path.lastIndexOf("/")) || "/";
      expectDocker(
        await docker(cli, ["exec", "-i", COMPUTER_NAME, "bash", "-lc", `mkdir -p ${quote(folder)} && cat > ${quote(path)}`], { input: content }),
        `write ${path}`,
      );
    },
  };

  return {
    backend: "local",
    async availability() {
      try {
        const current = await state();
        return current === "running" ? { state: "running" } : { state: current };
      } catch (error) {
        return { state: "unavailable", error: message(error) };
      }
    },
    async io() {
      return (await awake()) ? io : null;
    },
    async gatewayUrl() {
      if (!(await awake())) return null;
      // Concurrent opens share one setup instead of racing to create the forwarder.
      forwarding ??= forward().finally(() => {
        forwarding = null;
      });
      await forwarding;
      return `ws://127.0.0.1:${hostPort}/websockify?token=`;
    },
    keepAlive: async () => undefined,
  };
}

interface DockerResult {
  readonly exitCode: number;
  readonly stdout: Buffer;
  readonly stderr: string;
}

/** Runs the Docker CLI, feeding `input` on stdin and killing it after `timeoutMs`. */
function docker(cli: string, args: readonly string[], options: { input?: Uint8Array; timeoutMs?: number } = {}): Promise<DockerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cli, args, { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 120_000);
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      err += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error((error as NodeJS.ErrnoException).code === "ENOENT" ? "Docker is not installed. Install Docker Desktop, or unset BOT_COMPUTER to use Vercel Sandbox." : message(error)));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, stdout: Buffer.concat(out), stderr: err });
    });
    child.stdin.end(options.input === undefined ? undefined : Buffer.from(options.input));
  });
}

function expectDocker(result: DockerResult, what: string): void {
  if (result.exitCode !== 0) throw new Error(`Could not ${what}: ${dockerProblem(result.stderr)}`);
}

function dockerProblem(stderr: string): string {
  if (/cannot connect to the docker daemon|failed to connect to the docker api|docker daemon is not running/i.test(stderr)) {
    return "Docker is not running. Start Docker Desktop, or unset BOT_COMPUTER to use Vercel Sandbox.";
  }
  return stderr.trim().slice(0, 400) || "Docker reported an error.";
}

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

function notFound(error: unknown): boolean {
  const status = (error as { response?: { status?: number } } | null)?.response?.status;
  return status === 404 || /\b404\b|not found/i.test(message(error));
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
