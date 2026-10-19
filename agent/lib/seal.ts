import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Sealing for secrets kept in the store (AES-256-GCM), with a key derived from
 * the computer's access key and a label per use, so a secret sealed for one
 * purpose never opens for another. Connector keys use the same scheme under
 * their own label (see `connectors.ts`).
 */
async function keyFor(label: string): Promise<Buffer> {
  // Loaded lazily: the access key lives in the store, which workflow bundles can't take.
  const { computerKey } = await import("./computer/keys");
  return createHash("sha256").update(`${label}:${await computerKey()}`).digest();
}

export async function sealWith(label: string, text: string): Promise<string> {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", await keyFor(label), iv);
  const body = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map((part) => part.toString("base64url")).join(".");
}

/** The secret, or null when it can't be opened (damaged, or sealed with another key, as after an import). */
export async function unsealWith(label: string, sealed: string): Promise<string | null> {
  try {
    const [iv, tag, body] = sealed.split(".").map((part) => Buffer.from(part, "base64url"));
    if (iv === undefined || tag === undefined || body === undefined) return null;
    const decipher = createDecipheriv("aes-256-gcm", await keyFor(label), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
