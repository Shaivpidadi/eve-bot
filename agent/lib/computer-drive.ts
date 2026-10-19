import { Drive, Sandbox as VercelSandbox } from "@vercel/sandbox";

import { COMPUTER_NAME } from "./computer";
import { COMPUTER_SCRIPT } from "./computer/script";
import type { ComputerIo } from "./hands";
import { liveEnv } from "./settings/store";

/**
 * The team computer's work on a Vercel Drive (`BOT_COMPUTER_DRIVE=on`).
 *
 * A Vercel Sandbox keeps its files between sessions, but a machine that is lost
 * comes back empty, and until now only the 10-minute backups in
 * `computer-backup.ts` brought its files back. A Drive is storage of its own: it
 * outlives the machine, and every replacement mounts the same one. It is mounted
 * outside `/workspace` (eve owns that), and `bot-computer drive` binds the work
 * folders (`shared`, `bots`, `downloads`) and the browser profiles from it over
 * their usual places, so every path, guard and fence stays as it is, and the
 * team's sign-ins survive with the profiles.
 *
 * One machine mounts the drive read-write at a time, which is the one shared
 * computer. Vercel only: Docker and microsandbox keep the tar backups.
 */
export const DRIVE_MOUNT = "/team";

/** Whether this deployment keeps the computer's work on a drive. */
export function driveWanted(env: Readonly<Record<string, string | undefined>> = liveEnv()): boolean {
  return env.BOT_COMPUTER !== "local" && /^(1|true|on|yes)$/i.test(env.BOT_COMPUTER_DRIVE?.trim() ?? "");
}

/** The drive's name: the computer's, so changing `BOT_COMPUTER_NAME` starts a new drive with the new machine. */
export const DRIVE_NAME = COMPUTER_NAME;

/** The mount a new machine is made with, or nothing without a drive. */
export function driveMounts(env: Readonly<Record<string, string | undefined>> = liveEnv()) {
  return driveWanted(env) ? { [DRIVE_MOUNT]: { drive: DRIVE_NAME, mode: "read-write" as const } } : undefined;
}

/**
 * A drive still attached to the machine being replaced: Vercel lets it go about
 * ten seconds after that machine is deleted, so a start that meets it tries again.
 */
export function driveHeld(error: unknown): boolean {
  return /already attached as read-write/i.test(error instanceof Error ? error.message : String(error));
}

/** `BOT_COMPUTER_DRIVE_GB`, in bytes, or undefined for Vercel's default size. */
export function driveSize(env: Readonly<Record<string, string | undefined>> = process.env): number | undefined {
  const gb = Number(env.BOT_COMPUTER_DRIVE_GB);
  return Number.isFinite(gb) && gb > 0 ? Math.round(gb * 1024 ** 3) : undefined;
}

let made: Promise<void> | null = null;

/** Makes the drive if it does not exist yet. Once per process; a failure is retried next time. */
export function ensureDrive(env: Readonly<Record<string, string | undefined>> = liveEnv()): Promise<void> {
  made ??= (async () => {
    const maxSize = driveSize(env);
    await Drive.getOrCreate({ name: DRIVE_NAME, ...(maxSize === undefined ? {} : { maxSize }) });
  })().catch((error: unknown) => {
    made = null;
    throw new Error(`Could not get the computer's drive "${DRIVE_NAME}" ready: ${error instanceof Error ? error.message : String(error)}`);
  });
  return made;
}

/**
 * Gives an existing machine the drive. Vercel applies mounts from the machine's
 * next session, so a running machine keeps working as it is and picks the drive
 * up the next time it starts; `bot-computer drive` then moves its files over.
 */
export async function attachDrive(sandboxName: string, env: Readonly<Record<string, string | undefined>> = liveEnv()): Promise<boolean> {
  const mounts = driveMounts(env);
  if (mounts === undefined) return false;
  await ensureDrive(env);
  const sandbox = await VercelSandbox.get({ name: sandboxName });
  if (sandbox.mounts?.[DRIVE_MOUNT]?.drive === DRIVE_NAME) return false;
  await sandbox.update({ mounts });
  return true;
}

export interface DriveBinding {
  /** The drive is not claimed yet: nothing has restored onto it (see `claimDrive`). */
  readonly fresh: boolean;
  /** The folders bound from it now. */
  readonly bound: readonly string[];
}

type Runs = Pick<ComputerIo, "run">;

/** Brings the computer's own scripts up to date before using one (see `computer/runtime.ts`). */
async function currentScripts(io: ComputerIo): Promise<void> {
  const { ensureRuntime } = await import("./computer/runtime");
  await ensureRuntime(io);
}

/**
 * Binds the work folders from the drive, idempotently; null on a machine that
 * has not mounted the drive yet (one made before it, until its next start).
 */
export async function bindDrive(io: ComputerIo, options: { ensure?: (io: ComputerIo) => Promise<void> } = {}): Promise<DriveBinding | null> {
  await (options.ensure ?? currentScripts)(io);
  const result = await io.run(`${COMPUTER_SCRIPT} drive ${DRIVE_MOUNT}`, { timeoutMs: 5 * 60_000 });
  const line = result.stdout.trim().split("\n").pop() ?? "";
  const answer = parseAnswer(line);
  if (answer?.ok === true) return { fresh: answer.fresh === true, bound: (answer.bound ?? "").split(" ").filter((name) => name !== "") };
  if (/no drive is mounted/.test(answer?.error ?? "")) return null;
  throw new Error(answer?.error ?? (result.stderr.trim() || `bot-computer drive exited ${result.exitCode}`));
}

function parseAnswer(line: string): { ok?: boolean; fresh?: boolean; bound?: string; error?: string } | null {
  try {
    return JSON.parse(line) as { ok?: boolean; fresh?: boolean; bound?: string; error?: string };
  } catch {
    return null;
  }
}

/** Marks the drive as the team's copy of the work, so no backup restores over it again. */
export async function claimDrive(io: Runs): Promise<void> {
  const result = await io.run(`sudo -n touch ${DRIVE_MOUNT}/.bot-drive`);
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "could not mark the computer's drive");
}
