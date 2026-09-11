/**
 * Whether the address a request arrived on is behind Vercel Authentication.
 *
 * A deployment belongs to one owner, and Vercel itself keeps everyone else
 * out: with Vercel Authentication on, only people with access to the project
 * reach the app at all. The app does not take that on trust. It fetches its own
 * probe route on the same host, without credentials. A protected host answers
 * with Vercel's sign-in wall; an unprotected one lets the probe's marker
 * through. Anything unclear counts as unprotected, so a misconfiguration fails
 * closed.
 */
export const PROBE_PATH = "/bot/v1/setup/probe";
export const PROBE_MARKER = "bot-console-unprotected";

/** Turning protection off takes effect within this long. */
const PROTECTED_TTL_MS = 5 * 60_000;
const UNPROTECTED_TTL_MS = 20_000;
const PROBE_TIMEOUT_MS = 5_000;

const cache = new Map<string, { readonly protected: boolean; readonly until: number }>();

/** The host the caller used. On Vercel the edge sets these headers; callers cannot. */
export function requestHost(request: Request): string | null {
  const raw =
    request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? new URL(request.url).host;
  const host = raw.split(",")[0]?.trim().toLowerCase() ?? "";
  return /^[a-z0-9.-]+(:\d+)?$/.test(host) ? host : null;
}

export async function hostIsProtected(host: string): Promise<boolean> {
  const cached = cache.get(host);
  if (cached !== undefined && cached.until > Date.now()) return cached.protected;

  let result = false;
  try {
    const response = await fetch(`https://${host}${PROBE_PATH}`, {
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const walled = response.status === 401 || response.status === 403 || (response.status >= 300 && response.status < 400);
    const body = walled ? "" : await response.text();
    result = walled && !body.includes(PROBE_MARKER);
  } catch {
    result = false;
  }
  cache.set(host, { protected: result, until: Date.now() + (result ? PROTECTED_TTL_MS : UNPROTECTED_TTL_MS) });
  return result;
}
