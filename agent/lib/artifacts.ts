import { newId, slug } from "./ids";
import { store } from "./store";
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
  readonly base64: string;
}

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
