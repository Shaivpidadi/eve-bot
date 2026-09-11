import { createHmac, randomBytes } from "node:crypto";

/**
 * Access tokens for the computer's one public entry point.
 *
 * Vercel Sandbox exposes ports on public URLs with no authentication, so every
 * WebSocket into the computer carries a token minted here, by an authenticated
 * console route, and checked by the websockify plugin on the computer (see
 * `script.ts`). A token names exactly one screen and one service, expires within
 * seconds, and can open one connection only; the connection it opens stays up.
 */
export type ComputerTarget = "browser";
export type ComputerAccess = "view" | "control";

export interface TokenClaims {
  /** Screen number. */
  readonly n: number;
  readonly target: ComputerTarget;
  readonly access: ComputerAccess;
  /** Unix seconds. */
  readonly exp: number;
  /** Single-use: the plugin refuses a nonce it has already seen. */
  readonly nonce: string;
}

export const TOKEN_TTL_SECONDS = Number(process.env.BOT_COMPUTER_TOKEN_TTL_SECONDS ?? 60);

export function mintToken(
  key: string,
  claims: { n: number; target: ComputerTarget; access: ComputerAccess },
  ttlSeconds = TOKEN_TTL_SECONDS,
): string {
  const payload: TokenClaims = {
    ...claims,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
    nonce: randomBytes(12).toString("base64url"),
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(key, body)}`;
}

export function sign(key: string, body: string): string {
  return createHmac("sha256", key).update(body).digest("base64url");
}
