import type { Hands } from "./hands/types";
import { filesWritten, journalOf } from "./journal";
import { deleteDoc, readBytes, readDoc, updateDoc, writeBytes } from "./store";
import type { Job } from "./types";

/**
 * Points a job can be rewound to (plan item D5).
 *
 * The team's computer is shared, so a rewind must not undo other Bots' work:
 * a generation covers only what this job owns, its Bot's folder and the
 * files its journal says it wrote elsewhere in the workspace. Each is taken
 * at a journal index (when the run starts, at each decision, before an
 * outward action), kept in the store, and restored by `restoreGeneration`.
 * Files a Bot wrote through the shell outside its folder are not seen.
 */
export interface Generation {
  /** The journal length when it was taken: rewinding to this index restores it. */
  readonly index: number;
  readonly at: string;
  readonly reason: string;
  /** The paths it covers. */
  readonly paths: readonly string[];
  /** The archive in the store, or null when none of the paths existed yet. */
  readonly key: string | null;
  readonly bytes: number;
}

interface GenerationsDoc {
  readonly generations: readonly Generation[];
}

/** The first generation (where the job began) and the latest few are kept. */
export const KEEP_GENERATIONS = 10;

const docKey = (workspaceId: string, jobId: string) => `generations/${workspaceId}/${jobId}.json`;
const archiveKey = (workspaceId: string, jobId: string, index: number) => `generations/${workspaceId}/${jobId}/${index}-${Date.now().toString(36)}.tgz`;

/** The paths a job owns: its Bot's folder, by name as the Bot is told to use it, and the files its journal lists. */
export function scopeFor(job: Pick<Job, "journal">, botName: string): string[] {
  const folder = (name: string) => `/workspace/bots/${name.replace(/[^A-Za-z0-9 _.-]/g, "").trim()}`;
  const folders = [...new Set([folder(botName), folder(botName.toLowerCase())])].filter((path) => !path.endsWith("/bots/"));
  const files = filesWritten(journalOf(job)).filter((path) => path.startsWith("/workspace/") && !folders.some((dir) => path.startsWith(`${dir}/`)));
  return [...folders, ...files];
}

export async function listGenerations(workspaceId: string, jobId: string): Promise<readonly Generation[]> {
  return (await readDoc<GenerationsDoc>(docKey(workspaceId, jobId)))?.value.generations ?? [];
}

/** The generation to restore when rewinding to journal `index`: the latest taken at or before it. */
export function generationFor(generations: readonly Generation[], index: number): Generation | null {
  return [...generations].filter((generation) => generation.index <= index).sort((a, b) => b.index - a.index || b.at.localeCompare(a.at))[0] ?? null;
}

/** Which generations stay: the first, and the latest `keep - 1`. */
export function retained(generations: readonly Generation[], keep: number = KEEP_GENERATIONS): { keep: Generation[]; drop: Generation[] } {
  if (generations.length <= keep) return { keep: [...generations], drop: [] };
  const [first, ...rest] = generations;
  const tail = rest.slice(-(keep - 1));
  return { keep: [first!, ...tail], drop: rest.slice(0, rest.length - tail.length) };
}

/**
 * Takes a generation of what the job owns, at journal `index`. One per index:
 * a second call for the same index is the same point and is skipped.
 */
export async function takeGeneration(
  hands: Pick<Hands, "files">,
  input: { readonly workspaceId: string; readonly job: Job; readonly botName: string; readonly index: number; readonly reason: string },
): Promise<Generation | null> {
  const existing = await listGenerations(input.workspaceId, input.job.id);
  if (existing.some((generation) => generation.index === input.index)) return null;
  const paths = scopeFor(input.job, input.botName);
  const bytes = await hands.files.archive(paths);
  const key = bytes === null ? null : archiveKey(input.workspaceId, input.job.id, input.index);
  if (key !== null && bytes !== null) await writeBytes(key, bytes);
  const generation: Generation = { index: input.index, at: new Date().toISOString(), reason: input.reason, paths, key, bytes: bytes?.byteLength ?? 0 };
  let dropped: Generation[] = [];
  await updateDoc<GenerationsDoc>(docKey(input.workspaceId, input.job.id), (current) => {
    const all = [...(current?.generations ?? []).filter((g) => g.index !== generation.index), generation].sort((a, b) => a.index - b.index);
    const { keep, drop } = retained(all);
    dropped = drop;
    return { generations: keep };
  });
  for (const old of dropped) if (old.key !== null) await deleteDoc(old.key).catch(() => undefined);
  return generation;
}

/**
 * Puts the job's files back as they were at `generation`: every path the job
 * owns now or owned then is cleared, and the archive unpacked over them.
 */
export async function restoreGeneration(hands: Pick<Hands, "files">, generation: Generation, current: readonly string[]): Promise<void> {
  const archive = generation.key === null ? null : await readBytes(generation.key);
  if (generation.key !== null && archive === null) throw new Error(`The saved files for step ${generation.index} are missing from storage.`);
  await hands.files.restore([...new Set([...generation.paths, ...current])], archive);
}
