import { beforeEach, describe, expect, it, vi } from "vitest";

const request = (headers: Record<string, string> = {}, url = "http://bot.local/bot/v1/state") => new Request(url, { headers });

/** Who may open the console, and which workspace they see. */
describe("authenticate", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("BOT_CONSOLE_TOKEN", "");
    vi.stubEnv("BOT_CONSOLE_TOKENS", "");
    vi.stubEnv("BOT_CONSOLE_OPEN", "");
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("BOT_STORE", "memory");
  });

  it("binds each token to one workspace, from a header or the console's cookie", async () => {
    vi.stubEnv("BOT_CONSOLE_TOKEN", "top-secret");
    vi.stubEnv("BOT_CONSOLE_TOKENS", "acme-token=acme,bad entry,=nothing,globex-token=globex");
    const { authenticate, workspaceForToken, tokensConfigured } = await import("../agent/lib/access");
    expect(tokensConfigured()).toBe(true);
    expect(workspaceForToken("top-secret")).toBe("default");
    expect(workspaceForToken("acme-token")).toBe("acme");
    expect(workspaceForToken("globex-token")).toBe("globex");
    expect(workspaceForToken("nope")).toBeNull();

    const bearer = await authenticate(request({ authorization: "Bearer acme-token", "x-bot-user": "ann@acme.test" }));
    expect(bearer).toEqual({
      ok: true,
      access: { workspaceId: "acme", user: "ann@acme.test", profile: { name: "ann@acme.test", avatarUrl: null, source: "header" } },
    });
    const cookie = await authenticate(request({ cookie: "theme=dark; bot_console=globex-token" }));
    expect(cookie).toEqual({ ok: true, access: { workspaceId: "globex", user: "operator", profile: { name: "operator", avatarUrl: null, source: "none" } } });
    // Holding a token never grants another workspace.
    const wrong = await authenticate(request({ authorization: "Bearer acme-token", "x-bot-workspace": "globex" }));
    expect(wrong).toMatchObject({ ok: true, access: { workspaceId: "acme" } });
  });

  it("refuses without a valid token once tokens are configured", async () => {
    vi.stubEnv("BOT_CONSOLE_TOKEN", "top-secret");
    const { authenticate } = await import("../agent/lib/access");
    expect(await authenticate(request())).toEqual({ ok: false, status: 401, error: "unauthorized" });
    expect(await authenticate(request({ authorization: "Bearer wrong" }))).toMatchObject({ ok: false, status: 401 });
  });

  it("is open on a local dev server, where the caller may name the workspace", async () => {
    const { authenticate } = await import("../agent/lib/access");
    expect(await authenticate(request())).toEqual({
      ok: true,
      access: { workspaceId: "default", user: "operator", profile: { name: "operator", avatarUrl: null, source: "none" } },
    });
    expect(await authenticate(request({ "x-bot-workspace": "team-b" }))).toMatchObject({ ok: true, access: { workspaceId: "team-b" } });
    expect(await authenticate(request({}, "http://localhost:3000/bot/v1/state?workspace=team%20c"))).toMatchObject({ ok: false, status: 400 });
  });

  it("locks a production server that has no token, with standalone instructions off Vercel", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const standalone = await import("../agent/lib/access");
    const refused = await standalone.authenticate(request());
    expect(refused).toMatchObject({ ok: false, status: 503 });
    expect((refused as { error: string }).error).toMatch(/Set BOT_CONSOLE_TOKEN/);
    expect((refused as { error: string }).error).not.toMatch(/Vercel Authentication/);

    vi.resetModules();
    vi.stubEnv("BOT_CONSOLE_AUTH", "token");
    vi.stubEnv("VERCEL", "1");
    const vercel = await import("../agent/lib/access");
    expect(((await vercel.authenticate(request())) as { error: string }).error).toMatch(/Vercel Authentication/);

    vi.resetModules();
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("BOT_CONSOLE_OPEN", "1");
    const opened = await import("../agent/lib/access");
    expect(await opened.authenticate(request())).toMatchObject({ ok: true });
  });

  it("writes and clears the console cookie for the /bot path only", async () => {
    const { sessionCookie } = await import("../agent/lib/access");
    expect(sessionCookie("a b", request({}, "https://bot.example/bot/v1/session"))).toBe(
      "bot_console=a%20b; Path=/bot; HttpOnly; SameSite=Strict; Max-Age=2592000; Secure",
    );
    expect(sessionCookie(null, request({}, "http://localhost:3000/bot/v1/session/end"))).toBe(
      "bot_console=; Path=/bot; HttpOnly; SameSite=Strict; Max-Age=0",
    );
  });
});

/** Who the console shows, from the cookie Vercel Authentication sets. */
describe("profile", () => {
  it("names the Vercel user from the protection cookie, with a picture, and falls back in order", async () => {
    const { profile } = await import("../agent/lib/access");
    const claims = Buffer.from(JSON.stringify({ sub: "usr_123", username: "shaivpidadi", ownerId: "team_1", aud: "dpl_1" })).toString("base64url");
    const jwt = `header.${claims}.signature`;
    expect(profile(request({ cookie: `theme=dark; _vercel_jwt=${jwt}` }))).toEqual({
      name: "shaivpidadi",
      avatarUrl: "https://vercel.com/api/www/avatar/usr_123?s=64",
      source: "vercel",
    });
    // A caller who says who they are wins over the cookie.
    expect(profile(request({ cookie: `_vercel_jwt=${jwt}`, "x-bot-user": "ann@acme.test" })).name).toBe("ann@acme.test");
    // A damaged cookie is nobody, not an error.
    expect(profile(request({ cookie: "_vercel_jwt=not.a.jwt" }))).toEqual({ name: "operator", avatarUrl: null, source: "none" });
    expect(profile(request({ cookie: "_vercel_jwt=abc" }))).toEqual({ name: "operator", avatarUrl: null, source: "none" });
  });
});

/** A name set in the console stands in when nothing signs the person in by name. */
describe("stored name", () => {
  it("shows once set, yields to a header or Vercel, and clears with an empty name", async () => {
    vi.resetModules();
    vi.stubEnv("BOT_STORE", "memory");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("BOT_CONSOLE_TOKEN", "");
    vi.stubEnv("BOT_CONSOLE_TOKENS", "");
    vi.stubEnv("NODE_ENV", "test");
    const { authenticate, setStoredName, storedName } = await import("../agent/lib/access");
    expect(await storedName("default")).toBeNull();
    expect(await setStoredName("default", "  Shaishav   Pidadi ")).toBe("Shaishav Pidadi");
    expect(await authenticate(request())).toMatchObject({ ok: true, access: { user: "operator", profile: { name: "Shaishav Pidadi", source: "workspace" } } });
    expect(await authenticate(request({ "x-bot-user": "ann@acme.test" }))).toMatchObject({ ok: true, access: { profile: { name: "ann@acme.test", source: "header" } } });
    expect(await authenticate(request({ "x-bot-workspace": "team-b" }))).toMatchObject({ ok: true, access: { profile: { source: "none" } } });
    expect(await setStoredName("default", "   ")).toBeNull();
    expect(await authenticate(request())).toMatchObject({ ok: true, access: { profile: { name: "operator", source: "none" } } });
  });
});
