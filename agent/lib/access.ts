import { createHash, timingSafeEqual } from "node:crypto";

import { hostIsProtected, requestHost } from "./protection";

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
  const header = request.headers.get("x-bot-user")?.trim();
  return header ? header.slice(0, 200) : "operator";
}

/**
 * On Vercel the owner is whoever Vercel Authentication lets through, once the
 * app has confirmed the host is protected (see `protection.ts`).
 * `BOT_CONSOLE_AUTH=token` turns that off and accepts console tokens only.
 */
const vercelAuthentication = (): boolean =>
  process.env.VERCEL === "1" && process.env.BOT_CONSOLE_AUTH !== "token";

export async function authenticate(request: Request): Promise<Gate> {
  const token = presentedToken(request);
  const tokenWorkspace = token === null || !tokensConfigured() ? null : workspaceForToken(token);
  if (tokenWorkspace !== null) return { ok: true, access: { workspaceId: tokenWorkspace, user: user(request) } };

  if (vercelAuthentication()) {
    const host = requestHost(request);
    if (host !== null && (await hostIsProtected(host))) {
      return { ok: true, access: { workspaceId: DEFAULT_WORKSPACE, user: user(request) } };
    }
  }

  if (tokensConfigured()) return { ok: false, status: 401, error: "unauthorized" };
  if (!openAllowed()) {
    return {
      ok: false,
      status: 503,
      error:
        "This deployment is not protected. Turn on Vercel Authentication for all deployments, or set BOT_CONSOLE_TOKEN.",
    };
  }
  const workspaceId =
    request.headers.get("x-bot-workspace") ??
    new URL(request.url).searchParams.get("workspace") ??
    DEFAULT_WORKSPACE;
  if (!WORKSPACE.test(workspaceId)) return { ok: false, status: 400, error: "invalid workspace" };
  return { ok: true, access: { workspaceId, user: user(request) } };
}

/** Sets the console cookie, or clears it when `token` is null. */
export function sessionCookie(token: string | null, request: Request): string {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  const value = token === null ? "" : encodeURIComponent(token);
  const maxAge = token === null ? 0 : COOKIE_MAX_AGE_S;
  return `${COOKIE}=${value}; Path=/bot; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}
