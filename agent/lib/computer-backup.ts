import type { ToolContext } from "eve/tools";

import { record } from "./activity";
import { COMPUTER_NAME, COMPUTER_PATHS } from "./computer";
import { computerMode, localComputer } from "./computer-config";
import { bindDrive, claimDrive, driveWanted, type DriveBinding } from "./computer-drive";
import { currentKind, sandboxHands, type ComputerIo, type HandsKindName } from "./hands";
import { sandboxIo } from "./computer/runtime";
import { sessionBinding } from "./computer/screens";
import { operator } from "./session";
import { deleteDoc, readBytes, readDoc, writeBytes, writeDoc } from "./store";
import { effectiveEnv } from "./settings/store";

/**
 * Keeps the team's computer recoverable.
 *
 * The backend preserves the computer between conversations, but not forever: a
 * Vercel sandbox whose snapshot is gone, or a local container that was removed,
 * comes back as a fresh machine built from the template. So while Bots work,
 * the computer's files — `/workspace` and the home directory, minus caches and
 * per-run scratch — are archived to durable storage, and a computer that turns
 * up without them gets the latest archive restored before a job touches it.
 *
 * A marker file on the computer names the backup generation it holds. A machine
 * without the marker is a replacement; a machine with one is the original.
 *
 * With a drive (`BOT_COMPUTER_DRIVE`, see `computer-drive.ts`) the drive holds the
 * work and a replacement machine mounts it, so nothing restores over it: the
 * latest backup is restored once, onto a drive that is new, and the backups
 * become an hourly copy kept elsewhere.
 */

type Computer = Awaited<ReturnType<ToolContext["getSandbox"]>>;

interface Manifest {
  readonly generation: string;
  readonly at: string;
  readonly bytes: number;
  readonly archiveKey: string;
  /** The CPU architecture the archive was taken on (`uname -m`). Older manifests lack it. */
  readonly arch?: string;
  /** The kind of computer it was taken on (see `hands/kinds.ts`). Older manifests lack it. */
  readonly kind?: HandsKindName;
}

/**
 * Backups belong to one kind of computer. A local container and a Vercel sandbox
 * are different machines, often on different CPUs, and each has its own saved
 * sign-ins, so one's archive never restores onto the other. Vercel keeps the
 * original location, so existing deployments keep their backups.
 */
const PREFIX =
  computerMode() === "vercel" ? `computer/${COMPUTER_NAME}` : `computer/${COMPUTER_NAME}/local-${localComputer()}`;
const MANIFEST_KEY = `${PREFIX}/manifest.json`;
const MARKER_PATH = `${COMPUTER_PATHS.state}/generation`;
/**
 * Archives carry the sign-in jar and the gateway key, so they sit in the
 * computer's private run folder, which a Bot's shell cannot open (see
 * `computer/shell.ts`), never loose in /tmp.
 */
const PRIVATE_DIR = "/tmp/bot-computer";
const ARCHIVE_PATH = `${PRIVATE_DIR}/backup.tgz`;
const RESTORE_PATH = `${PRIVATE_DIR}/restore.tgz`;
const PRIVATE_DIR_COMMAND = `mkdir -p ${PRIVATE_DIR} && chmod 700 ${PRIVATE_DIR}`;

/** How often the computer is backed up, and the largest backup (Settings over the environment). */
const backupEveryMs = (env: Readonly<Record<string, string | undefined>>): number => {
  const minutes = Number(env.BOT_BACKUP_EVERY_MINUTES);
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : driveWanted(env) ? 60 : 10) * 60_000;
};
const maxArchiveBytes = (env: Readonly<Record<string, string | undefined>>): number => {
  const megabytes = Number(env.BOT_BACKUP_MAX_MB);
  return (Number.isFinite(megabytes) && megabytes > 0 ? megabytes : 512) * 1024 * 1024;
};
/** How long one process trusts a restore check before looking again. */
const VERIFIED_FOR_MS = 60_000;
/** Failures are worth one line in the feed, not one per progress note. */
const FAILURE_NOTICE_EVERY_MS = 60 * 60_000;

/**
 * Archives the computer's files. Paths are relative to `/` so the archive
 * restores onto any machine with the same layout. tar exits 1 when a file
 * changed while it was read, which still leaves a usable archive; a file a Bot's
 * shell left unreadable to the computer's user is skipped rather than failing
 * the whole backup. The last line
 * of output is the archive size in bytes.
 */
function archiveCommand(generation: string): string {
  const excludes = [
    "workspace/sessions",
    "workspace/attachments",
    // Claude Code and Codex on the owner's plan: their CLIs (reinstalled on use) and each run's files.
    "workspace/.engines",
    // Browser profiles are large and mostly cache; sign-ins travel in the
    // identity jar, which is kept.
    "workspace/.computer/chrome",
    "$HOME_REL/.cache",
    "$HOME_REL/.npm",
    "$HOME_REL/.agents",
    // Installed tools such as agent-browser are built for one CPU and are
    // reinstalled on use; restoring them could leave a binary that cannot run.
    "$HOME_REL/.local/lib/node_modules",
    "$HOME_REL/.local/bin",
  ]
    .map((pattern) => `--exclude="${pattern}"`)
    .join(" ");
  return [
    "set -e",
    `mkdir -p ${COMPUTER_PATHS.state}`,
    PRIVATE_DIR_COMMAND,
    "umask 077",
    `printf '%s' '${generation}' > ${MARKER_PATH}`,
    'HOME_REL="${HOME#/}"',
    'PATHS="workspace"',
    'case "$HOME" in /|/workspace|/workspace/*) ;; *) PATHS="$PATHS $HOME_REL" ;; esac',
    `rm -f ${ARCHIVE_PATH}`,
    `tar -czf ${ARCHIVE_PATH} --ignore-failed-read ${excludes} -C / $PATHS || [ $? -eq 1 ]`,
    `wc -c < ${ARCHIVE_PATH}`,
  ].join("\n");
}

const RESTORE_COMMAND = [
  "set -e",
  // Some images leave parts of the home directory to root, and tar then cannot recreate what is inside.
  'sudo -n chown "$(id -u):$(id -g)" "$HOME/.local" "$HOME/.local/share" 2>/dev/null || true',
  `tar -xzf ${RESTORE_PATH} -C /`,
  `rm -f ${RESTORE_PATH}`,
].join("\n");

/** The computer's CPU architecture, or null when it cannot be read. */
async function architecture(computer: Computer): Promise<string | null> {
  const result = await computer.run({ command: "uname -m" });
  const arch = result.stdout.trim();
  return result.exitCode === 0 && arch !== "" ? arch : null;
}

let verifiedAt = 0;
let restoring: Promise<boolean> | null = null;
let lastCheckpointAt = 0;
let checkpointing: Promise<void> | null = null;
let lastFailureNoticeAt = 0;

/**
 * Makes the computer look like a replacement machine: the generation marker
 * goes, so the next job restores the latest backup before it touches anything.
 * For the QA suite (see `lib/qa.ts`); the files themselves are left alone.
 */
export async function forgetGeneration(io: Pick<ComputerIo, "run">): Promise<void> {
  const result = await io.run(`rm -f ${MARKER_PATH}`);
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "could not remove the generation marker");
  verifiedAt = 0;
}

/** A backup restores onto the kind of computer it was taken on; one from before kinds were recorded restores anywhere it is found. */
export function restoresOnto(manifest: { readonly kind?: string }, kind: HandsKindName): boolean {
  return manifest.kind === undefined || manifest.kind === kind;
}

/**
 * Restores the latest backup if this computer is a replacement. Best-effort:
 * a failed restore is reported in the feed and the job carries on. False when
 * the computer may still be missing its files, so nothing may be backed up over
 * the latest backup.
 */
export async function ensureComputerRestored(ctx: ToolContext): Promise<boolean> {
  if (Date.now() - verifiedAt < VERIFIED_FOR_MS) return true;
  restoring ??= restoreIfReplaced(ctx).finally(() => {
    restoring = null;
  });
  return restoring;
}

/**
 * Backs the computer up, at most once per `minIntervalMs` (by default every
 * `BOT_BACKUP_EVERY_MINUTES`) across every process sharing the store.
 */
export async function checkpointComputer(
  ctx: ToolContext,
  options: { minIntervalMs?: number } = {},
): Promise<void> {
  const minIntervalMs = options.minIntervalMs ?? backupEveryMs(await effectiveEnv());
  // A backup already running covers this moment.
  if (checkpointing !== null || Date.now() - lastCheckpointAt < minIntervalMs) return;
  checkpointing = checkpoint(ctx, minIntervalMs).finally(() => {
    checkpointing = null;
  });
  await checkpointing;
}

async function currentGeneration(computer: Computer): Promise<string | null> {
  const result = await computer.run({ command: `cat ${MARKER_PATH} 2>/dev/null || true` });
  const value = result.stdout.trim();
  return value === "" ? null : value;
}

async function restoreIfReplaced(ctx: ToolContext): Promise<boolean> {
  let drive: DriveBinding | null = null;
  if (driveWanted()) {
    try {
      drive = await bindDrive(sandboxIo(await ctx.getSandbox(), ctx.abortSignal));
    } catch (error) {
      await noteFailure(ctx, `The computer's drive is not in use (${message(error)}), so new work is kept only by the backups.`);
    }
    if (drive !== null && !drive.fresh) {
      verifiedAt = Date.now();
      return true;
    }
  }
  if (!(await restoreFromBackup(ctx))) return false;
  if (drive?.fresh === true) {
    await claimDrive(sandboxIo(await ctx.getSandbox(), ctx.abortSignal)).catch((error: unknown) => noteFailure(ctx, `Could not mark the computer's drive: ${message(error)}`));
  }
  return true;
}

/** Restores the latest backup onto a replacement machine. False when that failed (reported in the feed). */
async function restoreFromBackup(ctx: ToolContext): Promise<boolean> {
  try {
    const manifest = (await readDoc<Manifest>(MANIFEST_KEY))?.value ?? null;
    if (manifest === null) {
      verifiedAt = Date.now();
      return true;
    }
    const computer = await ctx.getSandbox();
    if ((await currentGeneration(computer)) !== null) {
      verifiedAt = Date.now();
      return true;
    }
    const arch = await architecture(computer);
    const kind = currentKind();
    if (!restoresOnto(manifest, kind.name)) {
      verifiedAt = Date.now();
      await noteFailure(ctx, `Skipped restoring the computer: its backup from ${manifest.at} was taken on ${manifest.kind}, and this computer is ${kind.label}.`);
      return true;
    }
    if (manifest.arch !== undefined && arch !== null && arch !== manifest.arch) {
      // Programs in the archive would not run here; start clean instead of half-broken.
      verifiedAt = Date.now();
      await noteFailure(
        ctx,
        `Skipped restoring the computer: its backup from ${manifest.at} was taken on ${manifest.arch}, and this computer is ${arch}.`,
      );
      return true;
    }

    const archive = await readBytes(manifest.archiveKey);
    if (archive === null) throw new Error(`the backup from ${manifest.at} is missing from storage`);
    const prepared = await computer.run({ command: PRIVATE_DIR_COMMAND });
    if (prepared.exitCode !== 0) throw new Error(prepared.stderr.trim() || "could not prepare the computer's private folder");
    await computer.writeBinaryFile({ path: RESTORE_PATH, content: archive });
    const result = await computer.run({ command: RESTORE_COMMAND });
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || `tar exited ${result.exitCode}`);
    }
    verifiedAt = Date.now();
    await record({
      workspaceId: operator(ctx).workspaceId,
      kind: "computer.restored",
      text: `The computer was replaced, so its files were restored from the backup taken ${manifest.at}.`,
    });
    return true;
  } catch (error) {
    await noteFailure(ctx, `Could not restore the computer from its backup: ${message(error)}`);
    return false;
  }
}

async function checkpoint(ctx: ToolContext, minIntervalMs: number): Promise<void> {
  lastCheckpointAt = Date.now();
  try {
    const previous = (await readDoc<Manifest>(MANIFEST_KEY))?.value ?? null;
    if (previous !== null && Date.now() - Date.parse(previous.at) < minIntervalMs) {
      // Another process backed up recently.
      lastCheckpointAt = Date.parse(previous.at);
      return;
    }
    // Never archive a replacement machine before its files are back: the new
    // archive would replace the latest backup, and the old one is deleted below.
    if (!(await ensureComputerRestored(ctx))) {
      throw new Error("its files have not been restored from the latest backup yet, so that backup was kept");
    }

    const computer = await ctx.getSandbox();
    // Browser profiles are not archived, so save the team's sign-ins into the
    // identity jar first; a replacement computer's browsers start from it.
    const binding = await sessionBinding(operator(ctx).workspaceId, ctx.session.id);
    if (binding !== null) {
      await sandboxHands(computer, ctx.abortSignal).identity.export(binding.n).catch(() => undefined);
    }
    const generation = `gen_${Date.now().toString(36)}`;
    const archived = await computer.run({ command: archiveCommand(generation) });
    if (archived.exitCode !== 0) {
      throw new Error(archived.stderr.trim() || `tar exited ${archived.exitCode}`);
    }
    const size = Number(archived.stdout.trim().split("\n").pop());
    const maxBytes = maxArchiveBytes(await effectiveEnv());
    if (Number.isFinite(size) && size > maxBytes) {
      throw new Error(
        `the computer's files are ${Math.round(size / 1_048_576)} MB compressed, over the ${Math.round(maxBytes / 1_048_576)} MB backup limit (Settings, Team computer)`,
      );
    }

    const bytes = await computer.readBinaryFile({ path: ARCHIVE_PATH });
    if (bytes === null) throw new Error("the archive was not written");
    const archiveKey = `${PREFIX}/archives/${generation}.tgz`;
    // Archive first, manifest second: the manifest never points at a missing file.
    await writeBytes(archiveKey, bytes);
    const arch = await architecture(computer);
    const manifest: Manifest = {
      generation,
      at: new Date().toISOString(),
      bytes: bytes.byteLength,
      archiveKey,
      ...(arch === null ? {} : { arch }),
      kind: currentKind().name,
    };
    await writeDoc(MANIFEST_KEY, manifest);
    if (previous !== null && previous.archiveKey !== archiveKey) await deleteDoc(previous.archiveKey);
    await computer.run({ command: `rm -f ${ARCHIVE_PATH}` });
    lastCheckpointAt = Date.now();
  } catch (error) {
    await noteFailure(ctx, `Could not back up the computer: ${message(error)}`);
  }
}

async function noteFailure(ctx: ToolContext, text: string): Promise<void> {
  if (Date.now() - lastFailureNoticeAt < FAILURE_NOTICE_EVERY_MS) return;
  lastFailureNoticeAt = Date.now();
  try {
    await record({ workspaceId: operator(ctx).workspaceId, kind: "computer.failed", text: text.slice(0, 400) });
  } catch {
    // The feed is best-effort too.
  }
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
