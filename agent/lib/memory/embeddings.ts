import { embed, embedMany } from "ai";

import { gatewayReachable } from "../jev";
import { readDoc, updateDoc } from "../store";
import { recordUsage } from "../usage";
import { type MemoryEntry, type MemorySlot, normalize } from "./store";

/**
 * Meaning, not just words, for ranking lessons.
 *
 * "The export drops rows" and "CSV loses data from the report" share no words.
 * Once a Bot's craft memory holds a few hundred lessons, word overlap misses
 * too many of them, so on the Gateway each lesson gets a small embedding
 * (256 numbers, a fraction of a cent per hundred) kept beside the slot, and a
 * turn's question is embedded once and compared to all of them. Off the
 * Gateway, or when embedding fails, word overlap stands in unchanged.
 *
 * Vectors live in their own document so recall of the small slots never pays
 * for them, and each carries a digest of the text it was made from, so a
 * reworded entry is embedded again and a deleted one drops out.
 */

export const DEFAULT_EMBEDDING_MODEL = "openai/text-embedding-3-small";
export const DIMENSIONS = 256;
const BATCH = 64;

export interface VectorDoc {
  readonly model: string;
  readonly dimensions: number;
  /** By entry id: the digest of the text embedded, and the vector as base64 float32. */
  readonly vectors: Readonly<Record<string, { readonly digest: string; readonly vector: string }>>;
  readonly updatedAt: string;
}

const key = (workspaceId: string, slot: MemorySlot) => `memory/v2/${workspaceId}/${slot}.vectors.json`;

export function embeddingsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (/^(0|off|false|none)$/i.test(env.BOT_MEMORY_EMBEDDINGS ?? "")) return false;
  return gatewayReachable(env);
}

export const embeddingModel = (env: NodeJS.ProcessEnv = process.env): string => env.BOT_MEMORY_EMBEDDING_MODEL?.trim() || DEFAULT_EMBEDDING_MODEL;

/** A short digest of the text an embedding was made from, to know when it went stale. */
export function digest(text: string): string {
  let value = 2166136261;
  for (const char of normalize(text).toLowerCase()) {
    value ^= char.charCodeAt(0);
    value = Math.imul(value, 16777619) >>> 0;
  }
  return value.toString(36);
}

export function encode(vector: readonly number[]): string {
  return Buffer.from(new Float32Array(vector).buffer).toString("base64");
}

export function decode(encoded: string): Float32Array {
  const bytes = Buffer.from(encoded, "base64");
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}

/** Cosine similarity, on vectors that may or may not be unit length. */
export function cosine(left: ArrayLike<number>, right: ArrayLike<number>): number {
  const size = Math.min(left.length, right.length);
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < size; index += 1) {
    const l = left[index] ?? 0;
    const r = right[index] ?? 0;
    dot += l * r;
    leftNorm += l * l;
    rightNorm += r * r;
  }
  return leftNorm === 0 || rightNorm === 0 ? 0 : dot / Math.sqrt(leftNorm * rightNorm);
}

/** Embeds texts; injectable so tests need no Gateway. */
export type Embedder = (texts: readonly string[]) => Promise<readonly (readonly number[])[]>;

export function gatewayEmbedder(workspaceId: string, model: string = embeddingModel()): Embedder {
  return async (texts) => {
    if (texts.length === 0) return [];
    const options = { model, providerOptions: { openai: { dimensions: DIMENSIONS } }, maxRetries: 1, abortSignal: AbortSignal.timeout(15_000) };
    const result = texts.length === 1 ? await embed({ ...options, value: texts[0]! }).then((one) => ({ embeddings: [one.embedding], usage: one.usage, providerMetadata: one.providerMetadata })) : await embedMany({ ...options, values: [...texts] });
    const cost = (result.providerMetadata as { gateway?: { cost?: unknown } } | undefined)?.gateway?.cost;
    void recordUsage(workspaceId, "memory", {
      inputTokens: result.usage.tokens,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: typeof cost === "string" || typeof cost === "number" ? Number(cost) || 0 : 0,
      steps: 1,
      models: { [model]: 1 },
    }).catch(() => undefined);
    return result.embeddings;
  };
}

/**
 * Makes sure every entry given has a current vector, embedding the missing
 * and the stale in batches, and returns them all decoded. Entries that fail to
 * embed are simply absent, and the caller ranks them by words.
 */
export async function vectorsFor(
  workspaceId: string,
  slot: MemorySlot,
  entries: readonly MemoryEntry[],
  embedder: Embedder,
  model: string = embeddingModel(),
): Promise<ReadonlyMap<string, Float32Array>> {
  const stored = (await readDoc<VectorDoc>(key(workspaceId, slot)))?.value;
  const current = stored !== undefined && stored.model === model && stored.dimensions === DIMENSIONS ? stored.vectors : {};
  const out = new Map<string, Float32Array>();
  const missing: MemoryEntry[] = [];
  for (const entry of entries) {
    const have = current[entry.id];
    if (have !== undefined && have.digest === digest(entry.text)) out.set(entry.id, decode(have.vector));
    else missing.push(entry);
  }
  if (missing.length === 0) return out;

  const fresh: Record<string, { digest: string; vector: string }> = {};
  for (let start = 0; start < missing.length; start += BATCH) {
    const batch = missing.slice(start, start + BATCH);
    let embeddings: readonly (readonly number[])[];
    try {
      embeddings = await embedder(batch.map((entry) => entry.text));
    } catch {
      break;
    }
    batch.forEach((entry, index) => {
      const vector = embeddings[index];
      if (vector === undefined || vector.length === 0) return;
      fresh[entry.id] = { digest: digest(entry.text), vector: encode(vector) };
      out.set(entry.id, new Float32Array(vector));
    });
  }
  if (Object.keys(fresh).length === 0) return out;

  const keep = new Set(entries.map((entry) => entry.id));
  await updateDoc<VectorDoc>(key(workspaceId, slot), (doc) => {
    const base = doc !== null && doc.model === model && doc.dimensions === DIMENSIONS ? doc.vectors : {};
    const vectors: Record<string, { digest: string; vector: string }> = {};
    // Keep what is still an entry, drop what was deleted, take the new.
    for (const [id, value] of Object.entries(base)) if (keep.has(id)) vectors[id] = value;
    Object.assign(vectors, fresh);
    return { model, dimensions: DIMENSIONS, vectors, updatedAt: new Date().toISOString() };
  }).catch(() => undefined);
  return out;
}

/** Entries ranked by how close their meaning is to the query, above a floor; ties and the rest fall to the caller. */
export function rankByMeaning(
  entries: readonly MemoryEntry[],
  query: ArrayLike<number>,
  vectors: ReadonlyMap<string, ArrayLike<number>>,
  options: { readonly floor?: number; readonly weight?: (entry: MemoryEntry) => number } = {},
): readonly { readonly entry: MemoryEntry; readonly similarity: number }[] {
  const floor = options.floor ?? 0.25;
  const weight = options.weight ?? (() => 1);
  return entries
    .flatMap((entry) => {
      const vector = vectors.get(entry.id);
      if (vector === undefined) return [];
      const similarity = cosine(query, vector);
      return similarity >= floor ? [{ entry, similarity: similarity * weight(entry) }] : [];
    })
    .sort((left, right) => right.similarity - left.similarity);
}
