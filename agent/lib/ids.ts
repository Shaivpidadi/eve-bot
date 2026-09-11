import { randomUUID } from "node:crypto";

const ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";

/** Short, readable, collision-resistant ids: `bot_k3f9x2`, `job_9dq4mt`. */
export function newId(prefix: string): string {
  const uuid = randomUUID().replaceAll("-", "");
  let out = "";
  for (let index = 0; index < 6; index += 1) {
    const byte = Number.parseInt(uuid.slice(index * 2, index * 2 + 2), 16);
    out += ALPHABET[byte % ALPHABET.length];
  }
  return `${prefix}_${out}`;
}

/** Sortable activity keys, so the feed lists newest-last without an index. */
export function timeKey(at: string): string {
  return `${new Date(at).getTime().toString().padStart(14, "0")}-${newId("e").slice(2)}`;
}

export function slug(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "")
    .slice(0, 40);
}
