import { randomBytes } from "node:crypto";

import { COMPUTER_NAME } from "../computer";
import { readDoc, updateDoc } from "../store";

/**
 * The secret the app signs computer access tokens with, and the computer's
 * gateway checks them with.
 *
 * `BOT_COMPUTER_KEY` pins it; otherwise one is generated on first use and kept
 * in the app store, so every server process and the computer agree on it
 * without any setup.
 */
interface StoredKey {
  readonly key: string;
  readonly createdAt: string;
}

const KEY_DOC = `computer/${COMPUTER_NAME}/access-key.json`;
const MIN_KEY_LENGTH = 32;

let cached: Promise<string> | null = null;

export function computerKey(): Promise<string> {
  cached ??= loadKey().catch((error: unknown) => {
    cached = null;
    throw error;
  });
  return cached;
}

async function loadKey(): Promise<string> {
  const pinned = process.env.BOT_COMPUTER_KEY?.trim();
  if (pinned !== undefined && pinned !== "") {
    if (pinned.length < MIN_KEY_LENGTH) {
      throw new Error(`BOT_COMPUTER_KEY must be at least ${MIN_KEY_LENGTH} characters.`);
    }
    return pinned;
  }
  const stored = (await readDoc<StoredKey>(KEY_DOC))?.value;
  if (stored !== undefined) return stored.key;
  // Two processes racing to create the key both end up with whichever landed first.
  await updateDoc<StoredKey>(KEY_DOC, (current) =>
    current === null ? { key: randomBytes(32).toString("base64url"), createdAt: new Date().toISOString() } : null,
  );
  const created = (await readDoc<StoredKey>(KEY_DOC))?.value;
  if (created === undefined) throw new Error("Could not create the computer's access key.");
  return created.key;
}
