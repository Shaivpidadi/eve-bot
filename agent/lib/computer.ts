import { COMPUTER_HOME } from "./computer/script";

/**
 * One computer for the whole team.
 *
 * eve gives every durable session its own sandbox. Bot wants the opposite:
 * HQ, every Bot's thread, and every teammate at work share one machine, so the
 * files a Bot leaves behind are there for the next job. `team-computer.ts`
 * points every session at the same machine, while each session keeps its own
 * identity: browser session names and per-session caches key on it.
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
