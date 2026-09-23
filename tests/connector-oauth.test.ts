import { describe, expect, it } from "vitest";

import { authorizeUrl, beginPkce, discover, exchangeCode, needsRefresh, refreshTokens, registerClient, resourceMetadataUrl, type OAuthMetadata } from "../agent/lib/connector-oauth";

/** A fake MCP server and authorization server, the way Linear's answer. */
function fakeServer(options: { readonly registration?: boolean; readonly pathMetadata?: boolean; readonly rotateRefresh?: boolean } = {}) {
  const calls: { url: string; method: string; body: string | null }[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : null;
    calls.push({ url, method, body });
    const reply = (status: number, payload: unknown, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json", ...headers } });

    if (url === "https://mcp.example/mcp" && method === "POST") {
      return reply(401, { error: "unauthorized" }, options.pathMetadata === false ? { "www-authenticate": 'Bearer realm="OAuth"' } : { "www-authenticate": 'Bearer realm="OAuth", resource_metadata="https://mcp.example/.well-known/oauth-protected-resource/mcp", scope="read write"' });
    }
    if (url === "https://mcp.example/.well-known/oauth-protected-resource/mcp" || url === "https://mcp.example/.well-known/oauth-protected-resource") {
      return reply(200, { resource: "https://mcp.example/mcp", authorization_servers: ["https://mcp.example"], scopes_supported: ["read", "write"] });
    }
    if (url === "https://mcp.example/.well-known/oauth-authorization-server") {
      return reply(200, {
        issuer: "https://mcp.example",
        authorization_endpoint: "https://mcp.example/authorize",
        token_endpoint: "https://mcp.example/token",
        ...(options.registration === false ? {} : { registration_endpoint: "https://mcp.example/register" }),
        code_challenge_methods_supported: ["S256"],
      });
    }
    if (url === "https://mcp.example/register" && method === "POST") {
      const sent = JSON.parse(body ?? "{}") as { redirect_uris?: string[] };
      return reply(201, { client_id: "cli_123", redirect_uris: sent.redirect_uris });
    }
    if (url === "https://mcp.example/token" && method === "POST") {
      const form = new URLSearchParams(body ?? "");
      if (form.get("grant_type") === "authorization_code") {
        if (form.get("code") !== "good-code" || form.get("code_verifier") === null) return reply(400, { error: "invalid_grant", error_description: "bad code" });
        return reply(200, { access_token: "at-1", refresh_token: "rt-1", expires_in: 3600, scope: "read write" });
      }
      if (form.get("grant_type") === "refresh_token") {
        if (form.get("refresh_token") !== "rt-1") return reply(400, { error: "invalid_grant" });
        return reply(200, { access_token: "at-2", expires_in: 3600, ...(options.rotateRefresh ? { refresh_token: "rt-2" } : {}) });
      }
    }
    if (url === "https://open.example/mcp") return reply(200, { jsonrpc: "2.0", id: 1, result: {} });
    if (url === "https://keyed.example/mcp") return reply(401, { error: "unauthorized" }, { "www-authenticate": 'Bearer realm="api"' });
    return reply(404, { error: "not found" });
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

describe("OAuth for MCP servers", () => {
  it("reads the metadata URL out of the challenge header", () => {
    expect(resourceMetadataUrl('Bearer realm="OAuth", resource_metadata="https://mcp.linear.app/.well-known/oauth-protected-resource/mcp", scope="read write"')).toBe(
      "https://mcp.linear.app/.well-known/oauth-protected-resource/mcp",
    );
    expect(resourceMetadataUrl('Bearer realm="OAuth"')).toBeNull();
    expect(resourceMetadataUrl(null)).toBeNull();
  });

  it("discovers a server that runs its own OAuth, one that is open, and one that only takes a key", async () => {
    const server = fakeServer();
    const found = await discover("https://mcp.example/mcp", server.fetcher);
    expect(found).toEqual({
      kind: "oauth",
      metadata: {
        resource: "https://mcp.example/mcp",
        issuer: "https://mcp.example",
        authorizationEndpoint: "https://mcp.example/authorize",
        tokenEndpoint: "https://mcp.example/token",
        registrationEndpoint: "https://mcp.example/register",
        scopes: ["read", "write"],
        pkce: "S256",
      },
    });
    expect(await discover("https://open.example/mcp", server.fetcher)).toEqual({ kind: "open" });
    expect(await discover("https://keyed.example/mcp", server.fetcher)).toEqual({ kind: "key" });
    expect((await discover("https://gone.example/mcp", server.fetcher)).kind).toBe("unreachable");
    // Without the header naming it, the RFC 9728 path under the resource is tried.
    const quiet = fakeServer({ pathMetadata: false });
    expect((await discover("https://mcp.example/mcp", quiet.fetcher)).kind).toBe("oauth");
  });

  it("registers a client for the redirect URI, builds the consent URL with PKCE, and exchanges the code", async () => {
    const server = fakeServer();
    const found = await discover("https://mcp.example/mcp", server.fetcher);
    const metadata = (found as { metadata: OAuthMetadata }).metadata;
    const client = await registerClient(metadata, "https://bot.example/bot/v1/oauth/callback", server.fetcher);
    expect(client).toMatchObject({ clientId: "cli_123", clientSecret: null, redirectUri: "https://bot.example/bot/v1/oauth/callback" });
    const registration = JSON.parse(server.calls.find((call) => call.url.endsWith("/register"))!.body!) as Record<string, unknown>;
    expect(registration).toMatchObject({ client_name: "EVE Bot", token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"] });

    const pkce = beginPkce(metadata.pkce);
    expect(pkce.verifier).not.toBe(pkce.challenge);
    const url = new URL(authorizeUrl(metadata, client, pkce));
    expect(url.origin + url.pathname).toBe("https://mcp.example/authorize");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: "code",
      client_id: "cli_123",
      redirect_uri: "https://bot.example/bot/v1/oauth/callback",
      state: pkce.state,
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
      scope: "read write",
      resource: "https://mcp.example/mcp",
    });

    const tokens = await exchangeCode(metadata, client, "good-code", pkce.verifier, server.fetcher);
    expect(tokens).toMatchObject({ accessToken: "at-1", refreshToken: "rt-1", scope: "read write" });
    expect(tokens.expiresAt).toBeGreaterThan(Date.now() + 3_500_000);
    await expect(exchangeCode(metadata, client, "bad-code", pkce.verifier, server.fetcher)).rejects.toThrow(/refused the token request \(400\): bad code/);
  });

  it("refreshes when due, keeps the old refresh token unless the server rotates it, and refuses without one", async () => {
    const metadata: OAuthMetadata = { resource: "https://mcp.example/mcp", issuer: "https://mcp.example", authorizationEndpoint: "https://mcp.example/authorize", tokenEndpoint: "https://mcp.example/token", registrationEndpoint: null, scopes: [], pkce: "S256" };
    const client = { clientId: "cli_123", clientSecret: null, redirectUri: "https://bot.example/cb", registeredAt: "" };
    const soon = { accessToken: "at-1", refreshToken: "rt-1", expiresAt: Date.now() + 60_000, scope: null };
    expect(needsRefresh(soon)).toBe(true);
    expect(needsRefresh({ ...soon, expiresAt: Date.now() + 3_600_000 })).toBe(false);
    expect(needsRefresh({ ...soon, expiresAt: null })).toBe(false);

    const keeps = await refreshTokens(metadata, client, soon, fakeServer().fetcher);
    expect(keeps).toMatchObject({ accessToken: "at-2", refreshToken: "rt-1" });
    const rotates = await refreshTokens(metadata, client, soon, fakeServer({ rotateRefresh: true }).fetcher);
    expect(rotates.refreshToken).toBe("rt-2");
    await expect(refreshTokens(metadata, client, { ...soon, refreshToken: null }, fakeServer().fetcher)).rejects.toThrow(/No refresh token/);
    await expect(registerClient(metadata, "https://bot.example/cb", fakeServer().fetcher)).rejects.toThrow(/does not register clients/);
  });
});
