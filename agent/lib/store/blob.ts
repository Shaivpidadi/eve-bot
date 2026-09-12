import { BlobError, BlobPreconditionFailedError, del, get, list, put } from "@vercel/blob";

import { KvConflictError, isConflict, type Kv, type KvPutOptions } from "./kv";

/**
 * Vercel Blob storage: the production home for the bot roster, the job queue,
 * the activity feed, and saved artifacts.
 *
 * Blobs are written privately and read with the CDN cache bypassed, because the
 * job queue is read-modify-write and a cached read would hand out a stale
 * version token. ETags are the version tokens, so `ifMatch` gives us a real
 * compare-and-set across concurrent runtimes.
 */
/**
 * Whether a failed write lost a compare-and-set. @vercel/blob's errors do not
 * set `name`, so they are matched by class: a stale `ifMatch` throws
 * BlobPreconditionFailedError, and a create-only write to a key that already
 * exists throws a plain BlobError saying so.
 */
function isBlobConflict(error: unknown, expectedVersion: string | null | undefined): boolean {
  if (error instanceof BlobPreconditionFailedError) return true;
  return expectedVersion === null && error instanceof BlobError && /already exists/i.test(error.message);
}

/**
 * The version token for a read. Reads of larger documents come back with a
 * weak ETag (`W/"…"`, the same hash marked weak by compression in transit),
 * while writes and `ifMatch` use the strong form. Passing the weak form back
 * never matches, so every update to such a document would fail as a conflict.
 */
const strongEtag = (etag: string) => etag.replace(/^W\//, "");

/** Large uploads, such as computer backups, go up in parts. */
const MULTIPART_BYTES = 50 * 1024 * 1024;

export function blobKv(prefix: string): Kv {
  const pathFor = (key: string) => `${prefix}/${key}`;

  return {
    name: "vercel-blob",
    async get(key) {
      const result = await get(pathFor(key), { access: "private", useCache: false });
      if (result === null || result.statusCode !== 200) return null;
      return { value: await new Response(result.stream).text(), version: strongEtag(result.blob.etag) };
    },
    async put(key, value, options: KvPutOptions = {}) {
      const { expectedVersion } = options;
      try {
        const result = await put(pathFor(key), value, {
          access: "private",
          addRandomSuffix: false,
          allowOverwrite: expectedVersion !== null,
          cacheControlMaxAge: 60,
          contentType: "application/json; charset=utf-8",
          ...(typeof expectedVersion === "string" ? { ifMatch: expectedVersion } : {}),
        });
        return result.etag;
      } catch (error) {
        if (isConflict(error) || isBlobConflict(error, expectedVersion)) throw new KvConflictError(key);
        throw error;
      }
    },
    async delete(key) {
      await del(pathFor(key));
    },
    async putBytes(key, bytes) {
      await put(pathFor(key), Buffer.from(bytes), {
        access: "private",
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: "application/octet-stream",
        multipart: bytes.byteLength > MULTIPART_BYTES,
      });
    },
    async getBytes(key) {
      const result = await get(pathFor(key), { access: "private", useCache: false });
      if (result === null || result.statusCode !== 200) return null;
      return new Uint8Array(await new Response(result.stream).arrayBuffer());
    },
    async list(keyPrefix) {
      const keys: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await list({ prefix: pathFor(keyPrefix), cursor, limit: 1000 });
        for (const blob of page.blobs) keys.push(blob.pathname.slice(prefix.length + 1));
        cursor = page.hasMore ? page.cursor : undefined;
      } while (cursor !== undefined);
      return keys.sort();
    },
  };
}
