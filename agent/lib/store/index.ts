import { blobKv } from "./blob";
import { fileKv } from "./fs";
import { isConflict, type Kv } from "./kv";
import { inMemoryKv } from "./memory";

export { KvConflictError, isConflict, type Kv, type KvRecord } from "./kv";

let cached: Kv | undefined;

/**
 * Picks the durable store once per process.
 *
 * - `BOT_STORE=blob|fs|memory` forces a driver.
 * - Vercel Blob when its credentials are present, or when running on Vercel.
 * - Local disk (`BOT_DATA_DIR`, default `.data`) during `eve dev`.
 * - In-memory as the last resort, which is the only lossy option.
 */
export function store(): Kv {
  if (cached !== undefined) return cached;
  cached = select();
  return cached;
}

function select(): Kv {
  const prefix = process.env.BOT_STORE_PREFIX ?? "bot/v1";
  const forced = process.env.BOT_STORE;
  if (forced === "blob") return blobKv(prefix);
  if (forced === "fs") return fileKv(process.env.BOT_DATA_DIR ?? ".data");
  if (forced === "memory") return inMemoryKv();

  const hasBlob =
    process.env.BLOB_READ_WRITE_TOKEN !== undefined || process.env.BLOB_STORE_ID !== undefined;
  if (hasBlob || process.env.VERCEL === "1") return blobKv(prefix);
  if (process.env.BOT_DATA_DIR !== undefined || process.env.NODE_ENV !== "production") {
    return fileKv(process.env.BOT_DATA_DIR ?? ".data");
  }
  return inMemoryKv();
}

export interface Doc<T> {
  readonly value: T;
  readonly version: string;
}

export async function readDoc<T>(key: string): Promise<Doc<T> | null> {
  const record = await store().get(key);
  if (record === null) return null;
  return { value: JSON.parse(record.value) as T, version: record.version };
}

export async function writeDoc<T>(
  key: string,
  value: T,
  expectedVersion?: string | null,
): Promise<string> {
  return store().put(key, JSON.stringify(value, null, 2), { expectedVersion });
}

export function writeBytes(key: string, bytes: Uint8Array): Promise<void> {
  return store().putBytes(key, bytes);
}

export function readBytes(key: string): Promise<Uint8Array | null> {
  return store().getBytes(key);
}

export async function deleteDoc(key: string): Promise<void> {
  await store().delete(key);
}

export async function listDocs<T>(prefix: string): Promise<T[]> {
  const keys = await store().list(prefix);
  const docs = await Promise.all(keys.map((key) => readDoc<T>(key)));
  return docs.flatMap((doc) => (doc === null ? [] : [doc.value]));
}

/**
 * Serializes read-modify-write cycles for one key inside this process.
 *
 * Version checks alone are not enough here: two `updateDoc` calls in the same
 * runtime interleave at their `await` points, both read the same version, and
 * both then believe they won. The lock closes that window locally; the version
 * check below closes it between runtimes.
 */
const inFlight = new Map<string, Promise<unknown>>();

async function withKeyLock<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = inFlight.get(key) ?? Promise.resolve();
  const current = previous.then(run, run);
  const settled = current.then(
    () => undefined,
    () => undefined,
  );
  inFlight.set(key, settled);
  try {
    return await current;
  } finally {
    if (inFlight.get(key) === settled) inFlight.delete(key);
  }
}

/**
 * Read-modify-write with optimistic concurrency. `mutate` returns the next
 * value, or `null` to abandon the write (that is how a job claim reports "someone
 * else got there first" without throwing).
 *
 * A conflict means another writer committed in between, so the cycle re-reads
 * and re-runs `mutate` against the new value rather than overwriting it.
 */
export async function updateDoc<T>(
  key: string,
  mutate: (current: T | null) => T | null,
  attempts = 5,
): Promise<T | null> {
  return withKeyLock(key, async () => {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const doc = await readDoc<T>(key);
      const next = mutate(doc?.value ?? null);
      if (next === null) return null;
      try {
        await writeDoc(key, next, doc?.version ?? null);
        return next;
      } catch (error) {
        if (!isConflict(error) || attempt === attempts - 1) throw error;
        // The other writer may be another runtime mid-cycle: give it a moment, with jitter.
        await new Promise((resolve) => setTimeout(resolve, 40 * 2 ** attempt + Math.random() * 60));
      }
    }
    return null;
  });
}
