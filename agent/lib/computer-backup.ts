import type { ToolContext } from "eve/tools";

import { record } from "./activity";
import { COMPUTER_NAME, COMPUTER_PATHS } from "./computer";
import { exportIdentity, sandboxIo } from "./computer/runtime";
import { sessionBinding } from "./computer/screens";
import { operator } from "./session";
import { deleteDoc, readBytes, readDoc, writeBytes, writeDoc } from "./store";

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
 */

type Computer = Awaited<ReturnType<ToolContext["getSandbox"]>>;

interface Manifest {
  readonly generation: string;
  readonly at: string;
  readonly bytes: number;
  readonly archiveKey: string;
}

const PREFIX = `computer/${COMPUTER_NAME}`;
const MANIFEST_KEY = `${PREFIX}/manifest.json`;
const MARKER_PATH = `${COMPUTER_PATHS.state}/generation`;
const ARCHIVE_PATH = "/tmp/bot-computer-backup.tgz";
const RESTORE_PATH = "/tmp/bot-computer-restore.tgz";

const BACKUP_EVERY_MS = Number(process.env.BOT_BACKUP_EVERY_MINUTES ?? 10) * 60_000;
const MAX_ARCHIVE_BYTES = Number(process.env.BOT_BACKUP_MAX_MB ?? 512) * 1024 * 1024;
/** How long one process trusts a restore check before looking again. */
const VERIFIED_FOR_MS = 60_000;
/** Failures are worth one line in the feed, not one per progress note. */
const FAILURE_NOTICE_EVERY_MS = 60 * 60_000;

/**
 * Archives the computer's files. Paths are relative to `/` so the archive
 * restores onto any machine with the same layout. tar exits 1 when a file
 * changed while it was read, which still leaves a usable archive. The last line
 * of output is the archive size in bytes.
 */
function archiveCommand(generation: string): string {
  const excludes = [
    "workspace/sessions",
    "workspace/attachments",
    // Browser profiles are large and mostly cache; sign-ins travel in the
    // identity jar, which is kept.
    "workspace/.computer/chrome",
    "$HOME_REL/.cache",
    "$HOME_REL/.npm",
    "$HOME_REL/.agents",
  ]
    .map((pattern) => `--exclude="${pattern}"`)
    .join(" ");
  return [
    "set -e",
    `mkdir -p ${COMPUTER_PATHS.state}`,
    `printf '%s' '${generation}' > ${MARKER_PATH}`,
    'HOME_REL="${HOME#/}"',
    'PATHS="workspace"',
    'case "$HOME" in /|/workspace|/workspace/*) ;; *) PATHS="$PATHS $HOME_REL" ;; esac',
    `rm -f ${ARCHIVE_PATH}`,
    `tar -czf ${ARCHIVE_PATH} ${excludes} -C / $PATHS || [ $? -eq 1 ]`,
    `wc -c < ${ARCHIVE_PATH}`,
  ].join("\n");
}

const RESTORE_COMMAND = ["set -e", `tar -xzf ${RESTORE_PATH} -C /`, `rm -f ${RESTORE_PATH}`].join("\n");

let verifiedAt = 0;
let restoring: Promise<void> | null = null;
let lastCheckpointAt = 0;
let checkpointing: Promise<void> | null = null;
let lastFailureNoticeAt = 0;

/**
 * Restores the latest backup if this computer is a replacement. Best-effort:
 * a failed restore is reported in the feed and the job carries on.
 */
export async function ensureComputerRestored(ctx: ToolContext): Promise<void> {
  if (Date.now() - verifiedAt < VERIFIED_FOR_MS) return;
  restoring ??= restoreIfReplaced(ctx).finally(() => {
    restoring = null;
  });
  await restoring;
}

/**
 * Backs the computer up, at most once per `minIntervalMs` (by default every
 * `BOT_BACKUP_EVERY_MINUTES`) across every process sharing the store.
 */
export async function checkpointComputer(
  ctx: ToolContext,
  options: { minIntervalMs?: number } = {},
): Promise<void> {
  const minIntervalMs = options.minIntervalMs ?? BACKUP_EVERY_MS;
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

async function restoreIfReplaced(ctx: ToolContext): Promise<void> {
  try {
    const manifest = (await readDoc<Manifest>(MANIFEST_KEY))?.value ?? null;
    if (manifest === null) {
      verifiedAt = Date.now();
      return;
    }
    const computer = await ctx.getSandbox();
    if ((await currentGeneration(computer)) !== null) {
      verifiedAt = Date.now();
      return;
    }

    const archive = await readBytes(manifest.archiveKey);
    if (archive === null) throw new Error(`the backup from ${manifest.at} is missing from storage`);
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
  } catch (error) {
    await noteFailure(ctx, `Could not restore the computer from its backup: ${message(error)}`);
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
    // Never archive a replacement machine before its files are back.
    await ensureComputerRestored(ctx);

    const computer = await ctx.getSandbox();
    // Browser profiles are not archived, so save the team's sign-ins into the
    // identity jar first; a replacement computer's browsers start from it.
    const binding = await sessionBinding(operator(ctx).workspaceId, ctx.session.id);
    if (binding !== null) {
      await exportIdentity(sandboxIo(computer, ctx.abortSignal), binding.n).catch(() => undefined);
    }
    const generation = `gen_${Date.now().toString(36)}`;
    const archived = await computer.run({ command: archiveCommand(generation) });
    if (archived.exitCode !== 0) {
      throw new Error(archived.stderr.trim() || `tar exited ${archived.exitCode}`);
    }
    const size = Number(archived.stdout.trim().split("\n").pop());
    if (Number.isFinite(size) && size > MAX_ARCHIVE_BYTES) {
      throw new Error(
        `the computer's files are ${Math.round(size / 1_048_576)} MB compressed, over the ${Math.round(MAX_ARCHIVE_BYTES / 1_048_576)} MB backup limit (BOT_BACKUP_MAX_MB)`,
      );
    }

    const bytes = await computer.readBinaryFile({ path: ARCHIVE_PATH });
    if (bytes === null) throw new Error("the archive was not written");
    const archiveKey = `${PREFIX}/archives/${generation}.tgz`;
    // Archive first, manifest second: the manifest never points at a missing file.
    await writeBytes(archiveKey, bytes);
    const manifest: Manifest = { generation, at: new Date().toISOString(), bytes: bytes.byteLength, archiveKey };
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
