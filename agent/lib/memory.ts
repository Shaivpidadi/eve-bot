import { fileMemory, MemoryDocumentConflictError, type MemoryDocumentBackend } from "eve/memory/file";

import { isConflict, store } from "./store";

/**
 * Memory, kept in the app's own store.
 *
 * Every slot uses eve's file memory: one bounded document per scope, recalled
 * before each turn and maintained by the model with `<slot>__save_memory` and
 * `<slot>__remove_memory`. The documents live where the rest of the app's data
 * does, local disk in development and Vercel Blob when deployed, so memory
 * survives a dev-server restart and needs no store of its own.
 */

export type MemorySlot = "profile" | "team" | "craft";

export const MEMORY_SLOTS = {
  profile: { maxCharacters: 6_000 },
  team: { maxCharacters: 6_000 },
  craft: { maxCharacters: 4_000 },
} as const satisfies Record<MemorySlot, { readonly maxCharacters: number }>;

/** eve's scope keys are opaque digests; encoded so any character is safe in a path. */
const documentKey = (key: string) => `memory/documents/${encodeURIComponent(key)}.md`;

const documents: MemoryDocumentBackend = {
  async read({ key }) {
    const record = await store().get(documentKey(key));
    return record === null ? null : { content: record.value, version: record.version };
  },
  async write({ key, content, expectedVersion }) {
    try {
      const version = await store().put(documentKey(key), content, { expectedVersion });
      return { content, version };
    } catch (error) {
      if (isConflict(error)) throw new MemoryDocumentConflictError(key);
      throw error;
    }
  },
};

/** eve's file memory for one slot, backed by the app's store. */
export function appMemory(slot: MemorySlot) {
  return fileMemory({ backend: documents, maxCharacters: MEMORY_SLOTS[slot].maxCharacters });
}
