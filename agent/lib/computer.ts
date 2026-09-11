import type { SandboxBackend, SandboxBackendHandle } from "eve/sandbox";

import { COMPUTER_HOME } from "./computer/script";

/**
 * One computer for the whole team.
 *
 * eve gives every durable session its own sandbox. Bot wants the opposite:
 * HQ, every Bot's thread, and every teammate at work share one machine, so the
 * files a Bot leaves behind are there for the next job. `sharedComputer` wraps
 * any backend so every session opens the same persistent sandbox, while each
 * session keeps its own identity — browser session names and per-session
 * caches key on it.
 *
 * The machine outlives any single conversation, so no session may stop or
 * delete it. Compute idles out on its own on Vercel and lives until the server
 * shuts down on local backends. Changing `BOT_COMPUTER_NAME` starts a new
 * machine; the old one's backups stay under its own name.
 */
export const COMPUTER_NAME = process.env.BOT_COMPUTER_NAME ?? "bot-computer";

/** Where things live on the computer. Bootstrap creates every one of these. */
export const COMPUTER_PATHS = {
  /** Material any Bot may reuse. */
  shared: "/workspace/shared",
  /** One folder per Bot for its own work. */
  bots: "/workspace/bots",
  /** Per-run scratch the tools use, such as screenshots. Not backed up. */
  sessions: "/workspace/sessions",
  downloads: "/workspace/downloads",
  /** The computer's own software, access key, browser profiles, and backup bookkeeping. */
  state: COMPUTER_HOME,
} as const;

export function sharedComputer<BO, SO>(inner: SandboxBackend<BO, SO>): SandboxBackend<BO, SO> {
  return {
    // Same name as the inner backend, so eve's per-backend behaviour and the
    // reconnect records it validates against this name keep working.
    name: inner.name,
    prewarm: (input) => inner.prewarm(input),
    async create(input) {
      const handle = await inner.create({ ...input, sessionKey: COMPUTER_NAME });
      return shareHandle(handle, input.sessionKey);
    },
  };
}

function shareHandle<SO>(handle: SandboxBackendHandle<SO>, sessionKey: string): SandboxBackendHandle<SO> {
  return {
    session: withSessionId(handle.session, sessionKey),
    useSessionFn: async (options) => withSessionId(await handle.useSessionFn(options), sessionKey),
    async captureState() {
      // eve reuses a reconnect record only when it names this session's key.
      return { ...(await handle.captureState()), sessionKey };
    },
    async delete() {
      // The computer belongs to the team, not to the conversation asking.
    },
    async stop() {
      // Other conversations may be mid-command on the same machine.
    },
    shutdown: () => handle.shutdown(),
  };
}

/** The shared session, reporting the calling session's id as its own. */
function withSessionId<T extends object>(session: T, id: string): T {
  return new Proxy(session, {
    get(target, property) {
      if (property === "id") return id;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
