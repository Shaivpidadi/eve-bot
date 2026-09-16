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
    expect(bearer).toEqual({ ok: true, access: { workspaceId: "acme", user: "ann@acme.test" } });
    const cookie = await authenticate(request({ cookie: "theme=dark; bot_console=globex-token" }));
    expect(cookie).toEqual({ ok: true, access: { workspaceId: "globex", user: "operator" } });
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
    expect(await authenticate(request())).toEqual({ ok: true, access: { workspaceId: "default", user: "operator" } });
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
