import { createHash, timingSafeEqual } from "node:crypto";

import { hostIsProtected, requestHost } from "./protection";
import { readDoc, writeDoc } from "./store";

/**
 * Who may use the console routes, and which workspace they see.
 *
 * A deployment is one owner's: on Vercel, Vercel Authentication decides who
 * gets in. Console tokens still work everywhere, and a local dev server is
 * open to this machine.
 *
 * Every token is bound to exactly one workspace, so holding a token never lets
 * a caller pick another workspace with a header. The browser console signs in
 * once and carries the token in an HttpOnly, SameSite=Strict cookie, which is
 * also what keeps other sites from posting to these routes.
 */
export interface Access {
  readonly workspaceId: string;
  /** Trusted from the header once the caller holds a token for the workspace. */
  readonly user: string;
  /** Who that is, for the console: a display name and, when Vercel knows them, a picture. */
  readonly profile: Profile;
}

export interface Profile {
  readonly name: string;
  readonly avatarUrl: string | null;
  /** Where the name came from: the caller's header, Vercel's sign-in, a name set in the console, or nothing (the shared operator). */
  readonly source: "header" | "vercel" | "workspace" | "none";
}

export type Gate =
  | { ok: true; access: Access }
  | { ok: false; status: 400 | 401 | 503; error: string };

const COOKIE = "bot_console";
const COOKIE_MAX_AGE_S = 30 * 24 * 60 * 60;
const WORKSPACE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const DEFAULT_WORKSPACE = process.env.BOT_DEFAULT_WORKSPACE ?? "default";

/** `BOT_CONSOLE_TOKEN` opens the default workspace; `BOT_CONSOLE_TOKENS="token=workspace,…"` adds more. */
const TOKENS: ReadonlyMap<string, string> = (() => {
  const tokens = new Map<string, string>();
  const single = process.env.BOT_CONSOLE_TOKEN?.trim();
  if (single) tokens.set(single, DEFAULT_WORKSPACE);
  for (const entry of (process.env.BOT_CONSOLE_TOKENS ?? "").split(",")) {
    const cut = entry.lastIndexOf("=");
    if (cut <= 0) continue;
    const token = entry.slice(0, cut).trim();
    const workspaceId = entry.slice(cut + 1).trim();
    if (token !== "" && WORKSPACE.test(workspaceId)) tokens.set(token, workspaceId);
  }
  return tokens;
})();

export const tokensConfigured = (): boolean => TOKENS.size > 0;

/** Open access is for a local dev server. A deployment must opt in explicitly. */
const openAllowed = (): boolean =>
  process.env.BOT_CONSOLE_OPEN === "1" ||
  (process.env.VERCEL !== "1" && process.env.NODE_ENV !== "production");

const digest = (value: string) => createHash("sha256").update(value).digest();

export function workspaceForToken(token: string): string | null {
  const presented = digest(token);
  let found: string | null = null;
  // Compare against every token in constant time; stop early and timing leaks which matched.
  for (const [candidate, workspaceId] of TOKENS) {
    if (timingSafeEqual(presented, digest(candidate))) found = workspaceId;
  }
  return found;
}

function presentedToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (header !== null && /^bearer\s+/i.test(header)) return header.replace(/^bearer\s+/i, "").trim();
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name !== COOKIE) continue;
    try {
      return decodeURIComponent(rest.join("="));
    } catch {
      return null;
    }
  }
  return null;
}

function user(request: Request): string {
  return profile(request).name;
}

/**
 * The signed-in Vercel user, from the cookie Vercel Authentication sets.
 *
 * On a protected deployment every request arrives with `_vercel_jwt`, whose
 * payload names the account that passed the sign-in. Vercel is the one who
 * checked it, at the edge, before the request reached here; reading the claims
 * only puts a name and a face on a caller that is already trusted. Nothing here
 * grants access: `authenticate` decides that from the protection probe.
 */
function vercelIdentity(request: Request): { name: string; avatarUrl: string | null } | null {
  const cookie = request.headers.get("cookie") ?? "";
  const match = /(?:^|;\s*)_vercel_jwt=([^;]+)/.exec(cookie);
  if (match === null || match[1] === undefined) return null;
  const parts = match[1].split(".");
  if (parts.length < 2 || parts[1] === undefined) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
    const name = [claims.username, claims.email, claims.sub].find((value): value is string => typeof value === "string" && value.trim() !== "");
    if (name === undefined) return null;
    const id = typeof claims.sub === "string" ? claims.sub : null;
    return { name: name.slice(0, 200), avatarUrl: id === null ? null : `https://vercel.com/api/www/avatar/${encodeURIComponent(id)}?s=64` };
  } catch {
    return null;
  }
}

export function profile(request: Request): Profile {
  const header = request.headers.get("x-bot-user")?.trim();
  if (header) return { name: header.slice(0, 200), avatarUrl: null, source: "header" };
  const vercel = vercelIdentity(request);
  if (vercel !== null) return { ...vercel, source: "vercel" };
  return { name: "operator", avatarUrl: null, source: "none" };
}

/**
 * On Vercel the owner is whoever Vercel Authentication lets through, once the
 * app has confirmed the host is protected (see `protection.ts`).
 * `BOT_CONSOLE_AUTH=token` turns that off and accepts console tokens only.
 */
const vercelAuthentication = (): boolean =>
  process.env.VERCEL === "1" && process.env.BOT_CONSOLE_AUTH !== "token";

// ---------------------------------------------------------------------------
// A name set in the console, for a workspace nobody signs in to by name.
// ---------------------------------------------------------------------------

const nameKey = (workspaceId: string) => `settings/${workspaceId}/operator.json`;
const NAME_MAX = 80;

export async function storedName(workspaceId: string): Promise<string | null> {
  const doc = (await readDoc<{ readonly name: string }>(nameKey(workspaceId)))?.value;
  return doc === undefined || doc.name.trim() === "" ? null : doc.name;
}

/** Sets, or with an empty name clears, what the console calls the person in this workspace. */
export async function setStoredName(workspaceId: string, raw: string): Promise<string | null> {
  const name = raw.trim().replace(/\s+/g, " ").slice(0, NAME_MAX);
  await writeDoc(nameKey(workspaceId), { name, at: new Date().toISOString() });
  return name === "" ? null : name;
}

/** Who this is, for the console and the session: a header or Vercel first, then the name set in the console. */
async function accessFor(request: Request, workspaceId: string): Promise<Access> {
  const known = profile(request);
  const name = known.source === "none" ? await storedName(workspaceId).catch(() => null) : null;
  return {
    workspaceId,
    user: user(request),
    profile: name === null ? known : { name, avatarUrl: null, source: "workspace" },
  };
}

export async function authenticate(request: Request): Promise<Gate> {
  const token = presentedToken(request);
  const tokenWorkspace = token === null || !tokensConfigured() ? null : workspaceForToken(token);
  if (tokenWorkspace !== null) return { ok: true, access: await accessFor(request, tokenWorkspace) };

  if (vercelAuthentication()) {
    const host = requestHost(request);
    if (host !== null && (await hostIsProtected(host))) {
      return { ok: true, access: await accessFor(request, DEFAULT_WORKSPACE) };
    }
  }

  if (tokensConfigured()) return { ok: false, status: 401, error: "unauthorized" };
  if (!openAllowed()) {
    return {
      ok: false,
      status: 503,
      error:
        process.env.VERCEL === "1"
          ? "This deployment is not protected. Turn on Vercel Authentication for all deployments, or set BOT_CONSOLE_TOKEN."
          : "This server has no console token. Set BOT_CONSOLE_TOKEN to a long random password and restart it.",
    };
  }
  const workspaceId =
    request.headers.get("x-bot-workspace") ??
    new URL(request.url).searchParams.get("workspace") ??
    DEFAULT_WORKSPACE;
  if (!WORKSPACE.test(workspaceId)) return { ok: false, status: 400, error: "invalid workspace" };
  return { ok: true, access: await accessFor(request, workspaceId) };
}

/** Sets the console cookie, or clears it when `token` is null. */
export function sessionCookie(token: string | null, request: Request): string {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  const value = token === null ? "" : encodeURIComponent(token);
  const maxAge = token === null ? 0 : COOKIE_MAX_AGE_S;
  return `${COOKIE}=${value}; Path=/bot; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}
