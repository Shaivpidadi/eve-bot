import { randomBytes, timingSafeEqual } from "node:crypto";

import { readDoc, writeDoc } from "./store";

/**
 * The server calling itself, for work that runs outside a request (a job's
 * workflow) and needs a channel route: delivering the outbox (see `outbox.ts`).
 *
 * The address is the one requests reach this server by, noted from the
 * console's own calls; a deployment can pin it with BOT_PUBLIC_URL. The call
 * carries a secret only this deployment's store holds, so the route it reaches
 * answers no one else. On a protected Vercel deployment it also carries the
 * project's automation bypass, when the project has one.
 */
const ORIGIN_KEY = "runtime/self.json";
const SECRET_KEY = "secrets/internal.json";
export const INTERNAL_HEADER = "x-bot-internal";

let knownOrigin: string | null = null;
let secret: string | null = null;

/** Remembers the address a request reached this server by, when it changes. */
export async function noteOrigin(request: Request): Promise<void> {
  const origin = new URL(request.url).origin;
  if (origin === knownOrigin) return;
  knownOrigin = origin;
  await writeDoc(ORIGIN_KEY, { origin, at: new Date().toISOString() }).catch(() => undefined);
}

async function origin(): Promise<string | null> {
  const pinned = process.env.BOT_PUBLIC_URL?.trim();
  if (pinned) return pinned.replace(/\/+$/, "");
  if (knownOrigin !== null) return knownOrigin;
  return (await readDoc<{ origin: string }>(ORIGIN_KEY).catch(() => null))?.value.origin ?? null;
}

export async function internalSecret(): Promise<string> {
  if (secret !== null) return secret;
  const stored = await readDoc<{ secret: string }>(SECRET_KEY);
  if (stored !== null) return (secret = stored.value.secret);
  const fresh = randomBytes(32).toString("base64url");
  try {
    await writeDoc(SECRET_KEY, { secret: fresh }, null);
    return (secret = fresh);
  } catch {
    // Another process wrote one first: use theirs.
    return (secret = (await readDoc<{ secret: string }>(SECRET_KEY))?.value.secret ?? fresh);
  }
}

export async function isInternal(request: Request): Promise<boolean> {
  const presented = request.headers.get(INTERNAL_HEADER) ?? "";
  const expected = await internalSecret();
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Asks this server to deliver its outbox now. Best effort: the outbox is
 * durable, and the console's poll and the watchdog deliver it otherwise.
 */
export async function flushOutboxSoon(): Promise<boolean> {
  const base = await origin();
  if (base === null) return false;
  const headers: Record<string, string> = { [INTERNAL_HEADER]: await internalSecret() };
  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim();
  if (bypass) headers["x-vercel-protection-bypass"] = bypass;
  try {
    const response = await fetch(`${base}/bot/v1/internal/flush`, { method: "POST", headers, signal: AbortSignal.timeout(10_000) });
    return response.ok;
  } catch {
    return false;
  }
}
