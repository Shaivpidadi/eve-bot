import type { SandboxSession } from "eve/sandbox";
import {
  defineSandboxProvider,
  type SandboxConnection,
  type SandboxJson,
  type SandboxProviderImplementation,
  type SandboxSessionContext,
} from "eve/sandbox/provider";

import { COMPUTER_NAME } from "./computer";
import { type ComputerProviderName, readMachineRecord, writeMachineRecord } from "./machine";

/**
 * One computer for the whole team, on eve's per-session sandboxes.
 *
 * eve gives every durable session a sandbox of its own. Bot wants the opposite:
 * HQ, every Bot's thread and every teammate at work share one machine, so the
 * files a Bot leaves behind are there for the next job. This provider wraps one
 * of eve's built-in providers (Vercel, Docker, microsandbox) and points every
 * session at the same native machine:
 *
 * - The first session ever creates it through the built-in provider, as if it
 *   were a session named after the computer, and its native state (the Vercel
 *   Sandbox name, the Docker container) is kept in the app store.
 * - Every session after that, and every resume, reconnects to that machine. If
 *   it is gone, a new one is created and recorded; the backups in
 *   `computer-backup.ts` restore its files.
 * - No session stops, deletes or ends it: other conversations may be mid-command.
 *
 * Every session's connection drives the same machine, and stopping one is a
 * no-op. The console reaches the machine by the recorded native name (see
 * `computer/control.ts`).
 */
export type { ComputerProviderName, MachineRecord } from "./machine";
export { machineName, readMachineRecord } from "./machine";

type Inner = SandboxProviderImplementation<object | undefined, SandboxJson, SandboxJson, object>;

/** A built-in environment's provider implementation, which eve keeps on a well-known symbol. */
export function innerImplementation(environment: object): Inner {
  const runtime = Reflect.get(environment, Symbol.for("eve.sandbox-provider-runtime")) as { implementation?: Inner } | undefined;
  if (runtime?.implementation === undefined) throw new Error("This eve version does not expose sandbox provider runtimes.");
  return runtime.implementation;
}

/** The calling session's connection to the shared machine: the team's, so no conversation stops it. */
function shared(connection: SandboxConnection<object>): SandboxConnection<object> {
  return {
    ...(connection.workspaceRoot === undefined ? {} : { workspaceRoot: connection.workspaceRoot }),
    spawn: (options) => connection.spawn(options),
    readFile: (options) => connection.readFile(options),
    writeFiles: (options) => connection.writeFiles(options),
    removePath: (options) => connection.removePath(options),
    stop: async () => undefined,
    ...(connection.close === undefined ? {} : { close: () => connection.close!() }),
    ...(connection.extensions === undefined ? {} : { extensions: connection.extensions }),
  };
}

/** What the machine-setup step needs from a connection: run a command, read and write a file. */
export type MachineSandbox = Pick<SandboxSession, "run" | "readBinaryFile" | "writeBinaryFile">;

const drain = async (stream: ReadableStream<Uint8Array>): Promise<string> => new Response(stream).text();

/** A connection as the few session methods the machine-setup step uses (eve builds the full session itself). */
export function connectionSandbox(connection: SandboxConnection<object>): MachineSandbox {
  const workingDirectory = connection.workspaceRoot ?? "/workspace";
  return {
    async run(options) {
      const process = await connection.spawn({ command: options.command, env: options.env ?? {}, workingDirectory: options.workingDirectory ?? workingDirectory, ...(options.signal === undefined ? {} : { signal: options.signal }) });
      const [stdout, stderr, { exitCode }] = await Promise.all([drain(process.stdout), drain(process.stderr), process.wait()]);
      return { exitCode, stdout, stderr };
    },
    async readBinaryFile(options) {
      const read = await connection.readFile({ path: options.path, ...(options.signal === undefined ? {} : { signal: options.signal }) });
      if (read === null) return null;
      return read instanceof Uint8Array ? read : new Uint8Array(await new Response(read).arrayBuffer());
    },
    async writeBinaryFile(options) {
      await connection.writeFiles({ files: [{ path: options.path, content: options.content }] });
    },
  };
}

export interface TeamComputerOptions {
  readonly provider: ComputerProviderName;
  /** The built-in environment the machine is made with, such as `VercelSandbox.environment({...})`. */
  readonly environment: object;
  /** Why the machine cannot start here, if it cannot: checked before every start, as a plain message. */
  readonly check?: () => string | null;
  /** What a new machine is opened with when the session asking gave nothing, as when a resume finds it gone. */
  readonly open?: object;
  /** Runs before a new machine is made, such as making the drive it mounts. */
  readonly beforeStart?: () => Promise<void>;
  /**
   * Runs every time a session gets the machine, new or reconnected, before the
   * session uses it; with the machine's native state. A failure is logged, not thrown.
   */
  readonly onMachine?: (sandbox: MachineSandbox, state: SandboxJson) => Promise<void>;
  /** A failed start that passes on its own, such as a drive the machine being replaced still holds: retried for a while. */
  readonly startAgain?: (error: unknown) => boolean;
}

/** How long a start that `startAgain` recognises is retried, and how often. */
export const START_RETRY = { forMs: 2 * 60_000, everyMs: 5_000 };

/** Where a machine from before this record existed can be found, by provider. */
function legacyState(provider: ComputerProviderName): SandboxJson | null {
  // eve 0.58's shared Vercel computer was a persistent sandbox named after the computer.
  return provider === "vercel" ? { sandboxName: COMPUTER_NAME, version: 3 } : null;
}

export const TeamComputer = defineSandboxProvider<TeamComputerOptions, object | undefined, SandboxJson, { readonly team: true }, object>({
  name: "team-computer",
  environment(options) {
    if (options === undefined) throw new Error("TeamComputer needs a provider and an environment.");
    const inner = innerImplementation(options.environment);

    /** The team's machine for this session: reconnected if it exists, created and recorded if not. */
    async function machine(ctx: SandboxSessionContext, open: object | undefined, artifact: SandboxJson): Promise<SandboxConnection<object>> {
      const problem = options.check?.() ?? null;
      if (problem !== null) throw new Error(problem);

      const record = await readMachineRecord();
      const known = record !== null && record.provider === options.provider ? record.state : legacyState(options.provider);
      if (known !== null) {
        let connection: SandboxConnection<object> | null = null;
        try {
          connection = await inner.resume({ ...ctx, session: { ...ctx.session, id: COMPUTER_NAME } }, artifact, known);
        } catch {
          // Gone, or made for an environment this one cannot resume: make a new one below.
        }
        if (connection !== null) {
          if (record === null) await writeMachineRecord({ provider: options.provider, state: known, at: new Date().toISOString() });
          return await ready(connection, known);
        }
      }
      await options.beforeStart?.();
      // As if the computer itself were the session: the built-in provider names the
      // machine from this id, so concurrent first starts converge on one machine.
      const started = await retried(() => inner.start({ ...ctx, session: { ...ctx.session, id: COMPUTER_NAME } }, open ?? options.open, artifact));
      await writeMachineRecord({ provider: options.provider, state: started.state, at: new Date().toISOString() });
      return await ready(started.connection, started.state);
    }

    async function retried<T>(start: () => Promise<T>): Promise<T> {
      const until = Date.now() + START_RETRY.forMs;
      for (;;) {
        try {
          return await start();
        } catch (error) {
          if (options.startAgain?.(error) !== true || Date.now() >= until) throw error;
          await new Promise((resolve) => setTimeout(resolve, START_RETRY.everyMs));
        }
      }
    }

    async function ready(connection: SandboxConnection<object>, state: SandboxJson): Promise<SandboxConnection<object>> {
      if (options.onMachine !== undefined) {
        await options.onMachine(connectionSandbox(connection), state).catch((error: unknown) => {
          console.warn("[computer]", error instanceof Error ? error.message : String(error));
        });
      }
      return connection;
    }

    return {
      prepare: (ctx) => inner.prepare(ctx),
      async start(ctx, open, artifact) {
        return { connection: shared(await machine(ctx, open, artifact)), state: { team: true } };
      },
      async resume(ctx, artifact) {
        return shared(await machine(ctx, undefined, artifact));
      },
      // The machine outlives every conversation; nothing to release when one ends.
      async onSessionEnd() {},
    };
  },
});
