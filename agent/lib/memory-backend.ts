import type { MemoryDocumentBackend } from "eve/memory/file";
import { vercelBlob } from "eve/memory/file/vercel";

/**
 * Where memory slots keep their documents.
 *
 * eve's file memory looks for a store of its own (`EVE_MEMORY_BLOB_*`, set up
 * with `eve add memory/file`). A one-click deploy connects a single Blob store
 * to the project instead, so on Vercel memory falls back to that store rather
 * than failing. Everywhere else eve picks: process memory in `eve dev`.
 */
export function memoryBackend(): MemoryDocumentBackend | undefined {
  if (process.env.VERCEL !== "1") return undefined;
  const storeId = process.env.EVE_MEMORY_BLOB_STORE_ID?.trim() || process.env.BLOB_STORE_ID?.trim();
  if (storeId) return vercelBlob({ storeId });
  const token = process.env.EVE_MEMORY_BLOB_READ_WRITE_TOKEN?.trim() || process.env.BLOB_READ_WRITE_TOKEN?.trim();
  if (token) return vercelBlob({ token });
  return undefined;
}
