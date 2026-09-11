/** Thrown after a request sent the browser to the sign-in page. */
export class SignedOutError extends Error {
  constructor() {
    super("signed out");
    this.name = "SignedOutError";
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function redirectToLogin(error?: "unconfigured"): void {
  window.location.assign(error === undefined ? "/bot/login" : `/bot/login?error=${error}`);
}

/**
 * A same-origin call to the agent's console routes. The session cookie rides
 * along; a missing or rejected one sends the browser to sign in.
 */
export async function api(
  path: string,
  init: { method?: string; body?: string; signal?: AbortSignal } = {},
): Promise<Response> {
  const response = await fetch(path, {
    credentials: "same-origin",
    method: init.method ?? "GET",
    body: init.body,
    signal: init.signal,
    headers: init.body === undefined ? undefined : { "content-type": "application/json" },
  });
  if (response.status === 401) {
    redirectToLogin();
    throw new SignedOutError();
  }
  if (response.status === 503) {
    redirectToLogin("unconfigured");
    throw new SignedOutError();
  }
  return response;
}

export async function errorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (isRecord(body) && typeof body.error === "string") return body.error;
  } catch {
    // Not JSON; the fallback says enough.
  }
  return fallback;
}
