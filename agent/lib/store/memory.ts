import { KvConflictError, type Kv, type KvPutOptions, type KvRecord } from "./kv";

interface Row {
  value: string;
  version: string;
}

const rows = new Map<string, Row>();
const blobs = new Map<string, Uint8Array>();
let counter = 0;

/** Process-local storage. Used by tests and as the last-resort fallback. */
export function inMemoryKv(): Kv {
  return {
    name: "memory",
    async get(key) {
      const row = rows.get(key);
      return row ? { ...row } : null;
    },
    async put(key, value, options: KvPutOptions = {}) {
      const current = rows.get(key) ?? null;
      assertVersion(key, current, options.expectedVersion);
      const version = `v${(counter += 1)}`;
      rows.set(key, { value, version });
      return version;
    },
    async delete(key) {
      rows.delete(key);
      blobs.delete(key);
    },
    async putBytes(key, bytes) {
      blobs.set(key, new Uint8Array(bytes));
    },
    async getBytes(key) {
      // Like the fs and Blob drivers, a document reads back as its bytes too.
      const bytes = blobs.get(key);
      if (bytes !== undefined) return new Uint8Array(bytes);
      const row = rows.get(key);
      return row === undefined ? null : new TextEncoder().encode(row.value);
    },
    async list(prefix) {
      // Documents and binary objects share one key space, as on disk and in Blob.
      return [...new Set([...rows.keys(), ...blobs.keys()])].filter((key) => key.startsWith(prefix)).sort();
    },
  };
}

function assertVersion(key: string, current: KvRecord | null, expected: string | null | undefined) {
  if (expected === undefined) return;
  if (expected === null && current !== null) throw new KvConflictError(key);
  if (expected !== null && current?.version !== expected) throw new KvConflictError(key);
}
