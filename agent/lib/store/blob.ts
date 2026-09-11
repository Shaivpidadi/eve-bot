import { del, get, list, put } from "@vercel/blob";

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
export function blobKv(prefix: string): Kv {
  const pathFor = (key: string) => `${prefix}/${key}`;

  return {
    name: "vercel-blob",
    async get(key) {
      const result = await get(pathFor(key), { access: "private", useCache: false });
      if (result === null || result.statusCode !== 200) return null;
      return { value: await new Response(result.stream).text(), version: result.blob.etag };
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
        if (isConflict(error)) throw new KvConflictError(key);
        throw error;
      }
    },
    async delete(key) {
      await del(pathFor(key));
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
