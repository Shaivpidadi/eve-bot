import { execFile } from "node:child_process";

import { customEndpoint } from "./models";

/**
 * What the sign-in page's setup check looks at on a standalone server, beyond
 * the settings it reads: whether Docker answers, for a local computer, and
 * whether the model endpoint answers. The page is open to anyone who can reach
 * the server, so each answer is cached for a while, every probe is short, and
 * only "ready or not" comes back: never an address, a key or an error's text.
 */
const CACHE_MS = 30_000;
const PROBE_MS = 4_000;

const cache = new Map<string, { readonly ready: boolean; readonly at: number }>();

async function cached(key: string, probe: () => Promise<boolean>): Promise<boolean> {
  const hit = cache.get(key);
  if (hit !== undefined && Date.now() - hit.at < CACHE_MS) return hit.ready;
  const ready = await probe().catch(() => false);
  cache.set(key, { ready, at: Date.now() });
  return ready;
}

/** Whether the Docker daemon answers, through the CLI eve uses (`EVE_DOCKER_PATH`, else `docker`). */
export function dockerReady(env: Readonly<Record<string, string | undefined>> = process.env): Promise<boolean> {
  const cli = env.EVE_DOCKER_PATH?.trim() || "docker";
  return cached(`docker:${cli}`, () => new Promise<boolean>((resolve) => {
    execFile(cli, ["version", "--format", "{{.Server.Version}}"], { timeout: PROBE_MS }, (error, stdout) => resolve(error === null && stdout.trim() !== ""));
  }));
}

/**
 * Whether the Bots can reach a model: on AI Gateway, that a credential is there
 * (a key, or Vercel's OIDC token); on your own endpoint, that it answers its
 * model list.
 */
export function modelsReady(env: Readonly<Record<string, string | undefined>> = process.env): Promise<{ readonly via: "gateway" | "endpoint"; readonly ready: boolean }> {
  const endpoint = customEndpoint();
  if (endpoint === null) {
    const ready = env.VERCEL === "1" || Boolean(env.AI_GATEWAY_API_KEY?.trim()) || Boolean(env.VERCEL_OIDC_TOKEN?.trim());
    return Promise.resolve({ via: "gateway", ready });
  }
  return cached(`endpoint:${endpoint.baseURL}`, async () => {
    const response = await fetch(`${endpoint.baseURL.replace(/\/+$/, "")}/models`, {
      headers: endpoint.apiKey ? { authorization: `Bearer ${endpoint.apiKey}` } : {},
      signal: AbortSignal.timeout(PROBE_MS),
    });
    await response.body?.cancel().catch(() => undefined);
    return response.ok;
  }).then((ready) => ({ via: "endpoint" as const, ready }));
}
