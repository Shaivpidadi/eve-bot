import { newId, slug } from "./ids";
import { readBytes, store, writeBytes } from "./store";
import type { JobArtifact } from "./types";

/**
 * Bots produce files — a screenshot proving a form was submitted, an exported
 * CSV, a drafted document. The sandbox is disposable, so anything worth keeping
 * is copied into durable storage and referenced from the job record.
 */
export const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;

const key = (workspaceId: string, artifactId: string, name: string) =>
  `artifacts/${workspaceId}/${artifactId}-${slug(name) || "file"}.json`;

interface StoredArtifact {
  readonly meta: JobArtifact;
  /** Base64 payload. Kept small on purpose; see MAX_ARTIFACT_BYTES. */
  readonly base64?: string;
  /** Where a large file's bytes are, stored apart (see `saveLargeArtifact`). */
  readonly bytesKey?: string;
}

/** The largest file `saveLargeArtifact` keeps, such as a job's browser recording. */
export const MAX_LARGE_ARTIFACT_BYTES = 50 * 1024 * 1024;

export async function saveArtifact(input: {
  workspaceId: string;
  name: string;
  mediaType: string;
  bytes: Uint8Array;
}): Promise<JobArtifact> {
  if (input.bytes.byteLength > MAX_ARTIFACT_BYTES) {
    throw new Error(
      `${input.name} is ${input.bytes.byteLength} bytes; the artifact limit is ${MAX_ARTIFACT_BYTES}. Summarize it or upload it to the destination system instead.`,
    );
  }
  const id = newId("art");
  const meta: JobArtifact = {
    id,
    name: input.name,
    mediaType: input.mediaType,
    bytes: input.bytes.byteLength,
    key: key(input.workspaceId, id, input.name),
    savedAt: new Date().toISOString(),
  };
  const payload: StoredArtifact = { meta, base64: Buffer.from(input.bytes).toString("base64") };
  await store().put(meta.key, JSON.stringify(payload), { expectedVersion: null });
  return meta;
}

export async function readArtifact(artifactKey: string): Promise<StoredArtifact | null> {
  const record = await store().get(artifactKey);
  return record === null ? null : (JSON.parse(record.value) as StoredArtifact);
}

/**
 * A file too large to keep inside a JSON record, such as a job's browser
 * recording: its bytes are stored on their own, and the record says where.
 */
export async function saveLargeArtifact(input: { workspaceId: string; name: string; mediaType: string; bytes: Uint8Array }): Promise<JobArtifact> {
  if (input.bytes.byteLength > MAX_LARGE_ARTIFACT_BYTES) {
    throw new Error(`${input.name} is ${input.bytes.byteLength} bytes; the limit is ${MAX_LARGE_ARTIFACT_BYTES}.`);
  }
  const id = newId("art");
  const meta: JobArtifact = {
    id,
    name: input.name,
    mediaType: input.mediaType,
    bytes: input.bytes.byteLength,
    key: key(input.workspaceId, id, input.name),
    savedAt: new Date().toISOString(),
  };
  const bytesKey = `artifact-bytes/${input.workspaceId}/${id}`;
  await writeBytes(bytesKey, input.bytes);
  const stored: StoredArtifact = { meta, bytesKey };
  await store().put(meta.key, JSON.stringify(stored), { expectedVersion: null });
  return meta;
}

/** An artifact's bytes, wherever they are kept. */
export async function artifactBytes(stored: StoredArtifact): Promise<Uint8Array | null> {
  if (stored.base64 !== undefined) return Buffer.from(stored.base64, "base64");
  return stored.bytesKey === undefined ? null : readBytes(stored.bytesKey);
}
