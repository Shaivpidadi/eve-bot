import { KvConflictError, type Kv, type KvPutOptions, type KvRecord } from "./kv";

interface Row {
  value: string;
  version: string;
}

const rows = new Map<string, Row>();
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
    },
    async list(prefix) {
      return [...rows.keys()].filter((key) => key.startsWith(prefix)).sort();
    },
  };
}

function assertVersion(key: string, current: KvRecord | null, expected: string | null | undefined) {
  if (expected === undefined) return;
  if (expected === null && current !== null) throw new KvConflictError(key);
  if (expected !== null && current?.version !== expected) throw new KvConflictError(key);
}
