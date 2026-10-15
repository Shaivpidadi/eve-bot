import { createGunzip, createGzip } from "node:zlib";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createInterface } from "node:readline";

import type { Kv } from "./kv";

/**
 * Moving a workspace between stores.
 *
 * Everything the app keeps outside eve's Workflow state is a key in one
 * store: documents (JSON, versioned) and binary objects (computer backups,
 * screenshots). An export is every key under the store, gzipped NDJSON:
 * a manifest line, then one line per key with its bytes in base64 and
 * whether it is a document. Import writes them into another store, of any
 * driver, and makes what cannot move safe: runs live in the Workflow state,
 * so an open job's lease is dropped (the watchdog re-dispatches it and its
 * journal lets the new run continue), and a room's session is cleared (the
 * console starts a fresh one).
 *
 * The format is plain on purpose: `gunzip | head` shows what is inside.
 */
export const FORMAT = "eve-bot-export/1";

/** The console's export route is on only when the deployment opts in. */
export const exportEnabled = (env: Readonly<Record<string, string | undefined>> = process.env): boolean => /^(on|1|true)$/i.test(env.BOT_EXPORT?.trim() ?? "");

export interface Manifest {
  readonly format: typeof FORMAT;
  readonly exportedAt: string;
  readonly from: string;
  readonly version: string;
  /** The one workspace exported, or null for the whole store. */
  readonly workspace: string | null;
  readonly secrets: boolean;
  readonly counts: { readonly docs: number; readonly bytes: number };
}

interface Line {
  readonly key: string;
  readonly doc: boolean;
  readonly data: string;
}

/** The computer's access key: connector keys and OAuth tokens are sealed with a key derived from it (see `connectors.ts`). */
const isSealingKey = (key: string): boolean => /^computer\/[^/]+\/access-key\.json$/.test(key);

/** Keys that hold credentials: connector keys and OAuth tokens, sealed, and the key they are sealed with. */
export const isSecretKey = (key: string): boolean => /^connectors\//.test(key) || /^oauth-pending\//.test(key) || isSealingKey(key);

/** Whether `key` belongs to `workspace`: some path segment is its id. Deployment-wide keys (the computer) belong to none. */
export const inWorkspace = (key: string, workspace: string): boolean => key.split("/").some((segment) => segment === workspace || segment === `${workspace}.json`);

/** A document is text that parses as JSON; anything else moves as bytes. */
function asDocument(bytes: Uint8Array): string | null {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    JSON.parse(text);
    return text;
  } catch {
    return null;
  }
}

export interface ExportOptions {
  readonly workspace?: string | null;
  readonly secrets?: boolean;
  readonly version?: string;
}

/** The keys an export takes, in order. */
export async function keysToExport(kv: Kv, options: ExportOptions = {}): Promise<string[]> {
  const keys = await kv.list("");
  const secrets = options.secrets !== false;
  return keys.filter((key) => {
    if (!secrets && isSecretKey(key)) return false;
    // The sealing key belongs to the deployment, but the workspace's sealed connectors are useless without it.
    if (options.workspace != null) return inWorkspace(key, options.workspace) || (secrets && isSealingKey(key));
    return true;
  });
}

/** Writes an export of `kv` to `out`, and returns its manifest. */
export async function exportTo(kv: Kv, out: Writable, options: ExportOptions = {}): Promise<Manifest> {
  const keys = await keysToExport(kv, options);
  const lines: string[] = [];
  let docs = 0;
  let bytes = 0;
  for (const key of keys) {
    const value = await kv.getBytes(key);
    if (value === null) continue;
    const doc = asDocument(value) !== null;
    if (doc) docs += 1;
    else bytes += 1;
    lines.push(JSON.stringify({ key, doc, data: Buffer.from(value).toString("base64") } satisfies Line));
  }
  const manifest: Manifest = {
    format: FORMAT,
    exportedAt: new Date().toISOString(),
    from: kv.name,
    version: options.version ?? "unknown",
    workspace: options.workspace ?? null,
    secrets: options.secrets !== false,
    counts: { docs, bytes },
  };
  await pipeline(Readable.from([JSON.stringify(manifest) + "\n", ...lines.map((line) => line + "\n")]), createGzip(), out);
  return manifest;
}

export type Conflict = "replace" | "skip" | "fail";

export interface ImportOptions {
  readonly onConflict?: Conflict;
  readonly dryRun?: boolean;
}

export interface ImportOutcome {
  readonly manifest: Manifest;
  readonly written: number;
  readonly skipped: number;
  /** Jobs whose run could not move: their lease was dropped. */
  readonly movedJobs: readonly { readonly workspaceId: string; readonly jobId: string; readonly botId: string; readonly title: string }[];
  /** Rooms whose session was cleared. */
  readonly rooms: number;
}

/** Reads an export from `input` into `kv`. */
export async function importFrom(kv: Kv, input: Readable, options: ImportOptions = {}): Promise<ImportOutcome> {
  const onConflict = options.onConflict ?? "replace";
  const reader = createInterface({ input: input.pipe(createGunzip()), crlfDelay: Infinity });
  let manifest: Manifest | null = null;
  let written = 0;
  let skipped = 0;
  let rooms = 0;
  const movedJobs: ImportOutcome["movedJobs"][number][] = [];

  for await (const raw of reader) {
    if (raw.trim() === "") continue;
    if (manifest === null) {
      const parsed = JSON.parse(raw) as Manifest;
      if (parsed.format !== FORMAT) throw new Error(`Not an EVE BOT export (format ${String(parsed.format)}).`);
      manifest = parsed;
      continue;
    }
    const line = JSON.parse(raw) as Line;
    let bytes: Uint8Array = Buffer.from(line.data, "base64");

    if (line.doc) {
      const adjusted = settle(line.key, new TextDecoder().decode(bytes));
      if (adjusted.job !== undefined) movedJobs.push(adjusted.job);
      if (adjusted.room) rooms += 1;
      bytes = new TextEncoder().encode(adjusted.text);
    }

    const exists = onConflict === "replace" ? false : (await kv.list(line.key)).includes(line.key);
    if (exists && onConflict === "fail") throw new Error(`${line.key} already exists in the destination.`);
    if (exists && onConflict === "skip") {
      skipped += 1;
      continue;
    }
    if (options.dryRun !== true) {
      if (line.doc) await kv.put(line.key, new TextDecoder().decode(bytes));
      else await kv.putBytes(line.key, bytes);
    }
    written += 1;
  }
  if (manifest === null) throw new Error("The export is empty.");
  return { manifest, written, skipped, movedJobs, rooms };
}

/**
 * What cannot move, made safe: an open job's lease names a run in the old
 * Workflow state, and a room's session lives there too.
 */
function settle(key: string, text: string): { text: string; job?: ImportOutcome["movedJobs"][number]; room?: boolean } {
  const job = /^jobs\/([^/]+)\/([^/]+)\.json$/.exec(key);
  if (job !== null) {
    const value = JSON.parse(text) as { id: string; botId: string; title: string; status: string; lease: unknown };
    if (value.lease == null || ["done", "failed", "cancelled"].includes(value.status)) return { text };
    return {
      text: JSON.stringify({ ...value, lease: null }, null, 2),
      job: { workspaceId: job[1] ?? "", jobId: value.id, botId: value.botId, title: value.title },
    };
  }
  if (/^rooms\/[^/]+\/[^/]+\.json$/.test(key)) {
    const value = JSON.parse(text) as { sessionId?: string | null; active?: boolean; pending?: unknown[] };
    if (value.sessionId == null && value.active !== true) return { text };
    return { text: JSON.stringify({ ...value, sessionId: null, active: false, pending: [], sentAt: null, turnAt: null }, null, 2), room: true };
  }
  return { text };
}
