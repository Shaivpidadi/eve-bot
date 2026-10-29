import type { CommandResult, ComputerStatus, FileEntry, InputEvent, ScreenCapture, ScreenStarted } from "../computer/runtime";

export type { CommandResult, ComputerStatus, FileEntry, InputEvent, ScreenCapture, ScreenStarted };

/**
 * What the brain needs from a machine.
 *
 * HQ and the Bots run in the app; the machine they work on is the hands.
 * Everything the app asks of it goes through this interface, so a second
 * kind of machine is a second implementation, not a rewrite of every caller.
 * Each method acts on the machine reached through one `ComputerIo` (eve's
 * sandbox handle for a Bot, the provider's SDK for a console route), which
 * `handsFor` binds once.
 *
 * Who controls a screen (a person's takeover) is not here: that is a record
 * in the app's store (`computer/screens.ts`), not something the machine does.
 */
export interface Hands {
  readonly kind: HandsKindId;

  readonly shell: {
    /** Runs one command as the machine's own user and waits for it. */
    run(command: string, options?: { timeoutMs?: number }): Promise<CommandResult>;
  };

  readonly files: {
    list(path: string): Promise<{ path: string; entries: FileEntry[]; truncated: boolean }>;
    read(path: string): Promise<{ path: string; bytes: Uint8Array }>;
    write(path: string, bytes: Uint8Array): Promise<{ path: string }>;
    remove(path: string): Promise<{ path: string }>;
    /** A gzipped archive of these workspace paths as they are now, or null when none exist. */
    archive(paths: readonly string[]): Promise<Uint8Array | null>;
    /** Puts these paths back as `archive` holds them, removing what it does not hold. */
    restore(paths: readonly string[], archive: Uint8Array | null): Promise<void>;
  };

  readonly screen: {
    /** Starts screen `n`'s display and browser; `wait: false` fails fast during a first-time install. */
    ensure(n: number, options?: { wait?: boolean }): Promise<ScreenStarted>;
    stop(n: number): Promise<void>;
    /** What screen `n` shows, or one tab of it when `targetId` names one. */
    capture(n: number, quality?: number, targetId?: string): Promise<ScreenCapture>;
    /** A person's click, key or scroll, from the console. */
    input(n: number, event: InputEvent): Promise<void>;
    status(): Promise<ComputerStatus>;
  };

  readonly browser: {
    /** Brings the browser window to the front of its screen. */
    raise(n: number): Promise<void>;
    /** Brings one Bot's tab to the front. */
    activate(n: number, targetId: string): Promise<{ ok: boolean }>;
    close(n: number, targetId: string): Promise<{ ok: boolean; closed?: boolean }>;
    /** Ends a finished run's agent-browser session, and the recording it made. */
    endRun(session: string): Promise<{ ok: boolean; ended?: boolean }>;
    open(n: number, url: string, options?: { ifBlank?: boolean }): Promise<void>;
    saveTabs(n: number): Promise<{ saved: number }>;
  };

  readonly identity: {
    /** Copies screen `n`'s sign-ins into the team's jar and every running browser. */
    sync(n: number): Promise<{ synced: number }>;
    /** Saves screen `n`'s sign-ins into the team's jar, which backups carry. */
    export(n: number): Promise<{ cookies: number }>;
  };

  readonly setup: {
    /** Installs the machine's software into a template, once. */
    install(): Promise<void>;
    /** Makes sure the runtime is there and current, installing it if not. */
    ensure(): Promise<void>;
    /** Restarts the machine's services after a stop or a resume. */
    recover(): Promise<void>;
  };
}

/** The kinds of machine the app knows how to drive. */
export type HandsKindId = "linux";
