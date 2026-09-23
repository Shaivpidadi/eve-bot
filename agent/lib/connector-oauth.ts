import { createHash, randomBytes } from "node:crypto";

/**
 * OAuth for MCP servers, run by this app.
 *
 * Remote MCP servers such as Linear, Notion, Atlassian and Sentry answer an
 * unauthenticated call with a 401 that names their protected-resource
 * metadata; that names an authorization server; and that publishes its
 * endpoints and, in every case above, a registration endpoint. So a
 * connector can be connected with one click and no setup at all: this app
 * registers itself as a client, sends the person to consent, and exchanges
 * the code. Nothing here knows about eve or the store; it is the protocol,
 * with `fetch` injectable so it can be tested against a fake server.
 *
 * RFC 9728 (protected resource metadata), RFC 8414 (authorization server
 * metadata), RFC 7591 (dynamic client registration), RFC 7636 (PKCE).
 */

export interface OAuthMetadata {
  /** The resource identifier the token is for; sent as `resource` where the server supports RFC 8707. */
  readonly resource: string;
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  /** Absent when the server does not register clients dynamically; a pre-registered client is then needed. */
  readonly registrationEndpoint: string | null;
  readonly scopes: readonly string[];
  readonly pkce: "S256" | "plain";
}

export interface OAuthClient {
  readonly clientId: string;
  readonly clientSecret: string | null;
  /** The redirect URI the client was registered with; a different one means registering again. */
  readonly redirectUri: string;
  readonly registeredAt: string;
}

export interface TokenSet {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  /** Epoch milliseconds, or null when the server gave no lifetime. */
  readonly expiresAt: number | null;
  readonly scope: string | null;
}

export type Fetcher = typeof fetch;

const TIMEOUT_MS = 12_000;
const CLIENT_NAME = "EVE Bot";

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: CLIENT_NAME, version: "0" } },
};

const signal = () => AbortSignal.timeout(TIMEOUT_MS);

/** The `resource_metadata` URL named in a `WWW-Authenticate: Bearer …` header, if any. */
export function resourceMetadataUrl(header: string | null): string | null {
  if (header === null) return null;
  const match = /resource_metadata="([^"]+)"/i.exec(header);
  return match?.[1] ?? null;
}

async function json(fetcher: Fetcher, url: string): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetcher(url, { headers: { accept: "application/json" }, signal: signal() });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const str = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value : null);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);

/** The authorization server's metadata, tried at the RFC 8414 path, the OpenID path, and the origin. */
async function authorizationServerMetadata(fetcher: Fetcher, issuer: string): Promise<Record<string, unknown> | null> {
  const base = new URL(issuer);
  const path = base.pathname.replace(/\/$/, "");
  const candidates = [
    `${base.origin}/.well-known/oauth-authorization-server${path}`,
    `${base.origin}${path}/.well-known/oauth-authorization-server`,
    `${base.origin}/.well-known/openid-configuration${path}`,
    `${base.origin}${path}/.well-known/openid-configuration`,
  ];
  for (const candidate of [...new Set(candidates)]) {
    const found = await json(fetcher, candidate);
    if (found !== null && str(found.authorization_endpoint) !== null && str(found.token_endpoint) !== null) return found;
  }
  return null;
}

export type Discovery = { readonly kind: "open" } | { readonly kind: "oauth"; readonly metadata: OAuthMetadata } | { readonly kind: "key" } | { readonly kind: "unreachable"; readonly error: string };

/**
 * What an MCP server wants from a caller: nothing, OAuth it can run itself,
 * or a key it cannot discover. Probes with an unauthenticated `initialize`.
 */
export async function discover(url: string, fetcher: Fetcher = fetch): Promise<Discovery> {
  let response: Response;
  try {
    response = await fetcher(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify(INITIALIZE),
      signal: signal(),
    });
  } catch (error) {
    return { kind: "unreachable", error: error instanceof Error ? error.message : String(error) };
  }
  if (response.ok) return { kind: "open" };
  if (response.status !== 401) return response.status === 403 ? { kind: "key" } : { kind: "unreachable", error: `The server answered ${response.status}.` };

  const challenge = response.headers.get("www-authenticate");
  const named = resourceMetadataUrl(challenge);
  const target = new URL(url);
  // RFC 9728 puts the metadata under the resource's path, then at the origin.
  const candidates = [named, `${target.origin}/.well-known/oauth-protected-resource${target.pathname.replace(/\/$/, "")}`, `${target.origin}/.well-known/oauth-protected-resource`].filter(
    (candidate): candidate is string => candidate !== null,
  );
  let resource: Record<string, unknown> | null = null;
  for (const candidate of [...new Set(candidates)]) {
    resource = await json(fetcher, candidate);
    if (resource !== null && strings(resource.authorization_servers).length > 0) break;
    resource = null;
  }
  const issuer = resource === null ? target.origin : (strings(resource.authorization_servers)[0] ?? target.origin);
  const server = await authorizationServerMetadata(fetcher, issuer);
  if (server === null) return { kind: "key" };
  const methods = strings(server.code_challenge_methods_supported);
  return {
    kind: "oauth",
    metadata: {
      resource: str(resource?.resource) ?? url,
      issuer: str(server.issuer) ?? issuer,
      authorizationEndpoint: str(server.authorization_endpoint)!,
      tokenEndpoint: str(server.token_endpoint)!,
      registrationEndpoint: str(server.registration_endpoint),
      scopes: strings(resource?.scopes_supported).length > 0 ? strings(resource?.scopes_supported) : strings(server.scopes_supported),
      pkce: methods.includes("S256") || methods.length === 0 ? "S256" : "plain",
    },
  };
}

/** Registers this app with the authorization server for one redirect URI. */
export async function registerClient(metadata: OAuthMetadata, redirectUri: string, fetcher: Fetcher = fetch): Promise<OAuthClient> {
  if (metadata.registrationEndpoint === null) throw new Error("This server does not register clients on its own; it needs a pre-registered client.");
  const response = await fetcher(metadata.registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: CLIENT_NAME,
      client_uri: "https://eve-bot.dev",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
    signal: signal(),
  });
  const body: unknown = await response.json().catch(() => null);
  const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const clientId = str(record.client_id);
  if (!response.ok || clientId === null) throw new Error(`The server refused to register a client (${response.status}): ${str(record.error_description) ?? str(record.error) ?? "no reason given"}.`);
  return { clientId, clientSecret: str(record.client_secret), redirectUri, registeredAt: new Date().toISOString() };
}

const base64url = (bytes: Buffer) => bytes.toString("base64url");

/** A PKCE verifier and its S256 challenge; the state doubles as the pending flow's id. */
export function beginPkce(method: OAuthMetadata["pkce"] = "S256"): { readonly verifier: string; readonly challenge: string; readonly method: OAuthMetadata["pkce"]; readonly state: string } {
  const verifier = base64url(randomBytes(48));
  const challenge = method === "S256" ? base64url(createHash("sha256").update(verifier).digest()) : verifier;
  return { verifier, challenge, method, state: base64url(randomBytes(24)) };
}

export function authorizeUrl(
  metadata: OAuthMetadata,
  client: OAuthClient,
  pkce: { readonly challenge: string; readonly method: OAuthMetadata["pkce"]; readonly state: string },
  scopes: readonly string[] = metadata.scopes,
): string {
  const url = new URL(metadata.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", client.clientId);
  url.searchParams.set("redirect_uri", client.redirectUri);
  url.searchParams.set("state", pkce.state);
  url.searchParams.set("code_challenge", pkce.challenge);
  url.searchParams.set("code_challenge_method", pkce.method);
  if (scopes.length > 0) url.searchParams.set("scope", scopes.join(" "));
  url.searchParams.set("resource", metadata.resource);
  return url.toString();
}

async function tokenRequest(metadata: OAuthMetadata, client: OAuthClient, form: Record<string, string>, fetcher: Fetcher): Promise<TokenSet> {
  const body = new URLSearchParams({ ...form, client_id: client.clientId, resource: metadata.resource });
  if (client.clientSecret !== null) body.set("client_secret", client.clientSecret);
  const response = await fetcher(metadata.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: body.toString(),
    signal: signal(),
  });
  const parsed: unknown = await response.json().catch(() => null);
  const record = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  const accessToken = str(record.access_token);
  if (!response.ok || accessToken === null) {
    throw new Error(`The server refused the token request (${response.status}): ${str(record.error_description) ?? str(record.error) ?? "no reason given"}.`);
  }
  const expiresIn = typeof record.expires_in === "number" ? record.expires_in : Number(record.expires_in);
  return {
    accessToken,
    refreshToken: str(record.refresh_token),
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : null,
    scope: str(record.scope),
  };
}

export function exchangeCode(metadata: OAuthMetadata, client: OAuthClient, code: string, verifier: string, fetcher: Fetcher = fetch): Promise<TokenSet> {
  return tokenRequest(metadata, client, { grant_type: "authorization_code", code, redirect_uri: client.redirectUri, code_verifier: verifier }, fetcher);
}

export async function refreshTokens(metadata: OAuthMetadata, client: OAuthClient, tokens: TokenSet, fetcher: Fetcher = fetch): Promise<TokenSet> {
  if (tokens.refreshToken === null) throw new Error("No refresh token; connect again.");
  const fresh = await tokenRequest(metadata, client, { grant_type: "refresh_token", refresh_token: tokens.refreshToken }, fetcher);
  // Servers that rotate refresh tokens send a new one; those that do not keep the old one valid.
  return { ...fresh, refreshToken: fresh.refreshToken ?? tokens.refreshToken };
}

/** How long before expiry a token counts as due for refresh. */
export const REFRESH_AHEAD_MS = 5 * 60 * 1000;

export const needsRefresh = (tokens: TokenSet, now: number = Date.now()): boolean => tokens.expiresAt !== null && tokens.expiresAt - now < REFRESH_AHEAD_MS;
