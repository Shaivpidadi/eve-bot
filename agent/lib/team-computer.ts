import type { SandboxSession } from "eve/sandbox";
import {
  defineSandboxProvider,
  type SandboxPreparedArtifact,
  type SandboxProviderHandle,
  type SandboxProviderImplementation,
  type SandboxProviderSessionContext,
} from "eve/sandbox/provider";

import { COMPUTER_NAME } from "./computer";

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
 * Each session's sandbox handle reports the session's own id (agent-browser
 * names its browser sessions by it), while every handle drives the same machine.
 * The console reaches the machine by the recorded native name (see
 * `computer/control.ts`).
 */
export type ComputerProviderName = "vercel" | "docker" | "microsandbox";

export interface MachineRecord {
  readonly provider: ComputerProviderName;
  /** The built-in provider's own state for the machine: what it needs to reconnect. */
  readonly state: SandboxPreparedArtifact;
  readonly at: string;
}

const RECORD_KEY = `computer/${COMPUTER_NAME}/machine.json`;

type Inner = SandboxProviderImplementation<object | undefined, SandboxPreparedArtifact, SandboxPreparedArtifact, SandboxSession>;

/** A built-in environment's provider implementation, which eve keeps on a well-known symbol. */
export function innerImplementation(environment: object): Inner {
  const runtime = Reflect.get(environment, Symbol.for("eve.sandbox-provider-runtime")) as { implementation?: Inner } | undefined;
  if (runtime?.implementation === undefined) throw new Error("This eve version does not expose sandbox provider runtimes.");
  return runtime.implementation;
}

export async function readMachineRecord(): Promise<MachineRecord | null> {
  const { readDoc } = await import("./store");
  return (await readDoc<MachineRecord>(RECORD_KEY))?.value ?? null;
}

async function writeMachineRecord(record: MachineRecord): Promise<void> {
  const { writeDoc } = await import("./store");
  await writeDoc(RECORD_KEY, record);
}

/**
 * The machine's native name, for code that reaches it without eve: the recorded
 * Vercel Sandbox or Docker container, or the computer's own name for a machine
 * from before this record existed (which the Vercel provider adopts).
 */
export async function machineName(): Promise<string> {
  const record = await readMachineRecord().catch(() => null);
  const state = (record?.state ?? null) as { sandboxName?: unknown; containerName?: unknown; name?: unknown } | null;
  const name = state?.sandboxName ?? state?.containerName ?? state?.name;
  return typeof name === "string" && name !== "" ? name : COMPUTER_NAME;
}

/** The calling session's view of the shared machine. */
function shared(handle: SandboxProviderHandle<SandboxSession>, sessionId: string): SandboxProviderHandle<SandboxSession> {
  const sandbox = new Proxy(handle.sandbox, {
    get(target, property) {
      if (property === "id") return sessionId;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    sandbox,
    onRuntimeShutdown: () => handle.onRuntimeShutdown(),
    // The computer belongs to the team, not to the conversation asking.
    onSandboxDelete: async () => undefined,
    onSandboxStop: async () => undefined,
  };
}

export interface TeamComputerOptions {
  readonly provider: ComputerProviderName;
  /** The built-in environment the machine is made with, such as `VercelSandbox.environment({...})`. */
  readonly environment: object;
  /** Why the machine cannot start here, if it cannot: checked before every start, as a plain message. */
  readonly check?: () => string | null;
}

/** Where a machine from before this record existed can be found, by provider. */
function legacyState(provider: ComputerProviderName): SandboxPreparedArtifact | null {
  // eve 0.58's shared Vercel computer was a persistent sandbox named after the computer.
  return provider === "vercel" ? { sandboxName: COMPUTER_NAME, version: 3 } : null;
}

export const TeamComputer = defineSandboxProvider<TeamComputerOptions, object | undefined, SandboxPreparedArtifact, { readonly team: true }, SandboxSession>({
  name: "team-computer",
  environment(options) {
    if (options === undefined) throw new Error("TeamComputer needs a provider and an environment.");
    const inner = innerImplementation(options.environment);

    /** The team's machine for this session: reconnected if it exists, created and recorded if not. */
    async function machine(ctx: SandboxProviderSessionContext, open: object | undefined, artifact: SandboxPreparedArtifact) {
      const problem = options.check?.() ?? null;
      if (problem !== null) throw new Error(problem);

      const record = await readMachineRecord();
      const known = record !== null && record.provider === options.provider ? record.state : legacyState(options.provider);
      if (known !== null) {
        try {
          const handle = await inner.resume(ctx, artifact, known);
          if (record === null) await writeMachineRecord({ provider: options.provider, state: known, at: new Date().toISOString() });
          return handle;
        } catch {
          // Gone, or made for an environment this one cannot resume: make a new one below.
        }
      }
      // As if the computer itself were the session: the built-in provider names the
      // machine from this id, so concurrent first starts converge on one machine.
      const started = await inner.start({ ...ctx, session: { ...ctx.session, id: COMPUTER_NAME } }, open, artifact);
      await writeMachineRecord({ provider: options.provider, state: started.state as SandboxPreparedArtifact, at: new Date().toISOString() });
      return started.handle;
    }

    return {
      prepare: (ctx) => inner.prepare(ctx),
      async start(ctx, open, artifact) {
        return { handle: shared(await machine(ctx, open, artifact), ctx.session.id), state: { team: true } };
      },
      async resume(ctx, artifact) {
        return shared(await machine(ctx, undefined, artifact), ctx.session.id);
      },
      // The machine outlives every conversation; nothing to release when one ends.
      async onSessionEnd() {},
    };
  },
});
