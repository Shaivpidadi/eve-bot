/**
 * The storage contract every Bot driver implements.
 *
 * Deliberately small: a versioned string get/put, a delete, and a prefix list.
 * Versions are opaque tokens (a Blob ETag, a content hash) used for optimistic
 * concurrency — that is what makes "claim this job exactly once" safe when two
 * cron ticks overlap.
 */
export interface KvRecord {
  readonly value: string;
  readonly version: string;
}

export interface KvPutOptions {
  /**
   * `undefined` overwrites unconditionally.
   * `null` requires the key to not exist yet.
   * A version string requires the stored version to match.
   */
  readonly expectedVersion?: string | null;
}

export interface Kv {
  readonly name: string;
  get(key: string): Promise<KvRecord | null>;
  put(key: string, value: string, options?: KvPutOptions): Promise<string>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
  /** Unversioned binary objects, such as computer backups. Last write wins. */
  putBytes(key: string, bytes: Uint8Array): Promise<void>;
  getBytes(key: string): Promise<Uint8Array | null>;
}

/** Thrown when an `expectedVersion` precondition fails. Callers retry. */
export class KvConflictError extends Error {
  constructor(key: string) {
    super(`Concurrent write to ${key}.`);
    this.name = "KvConflictError";
  }
}

export function isConflict(error: unknown): boolean {
  if (error instanceof KvConflictError) return true;
  const name = (error as { name?: string } | null)?.name ?? "";
  return name === "BlobPreconditionFailedError" || name === "BlobAlreadyExistsError";
}
