import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Settings that wait for a build (the spend caps, the engines) reach a
 * deployment's running server: `scripts/build.mjs` writes them into
 * `agent/lib/settings/built.ts`, which lays them over the environment when it
 * loads. And the owner can ask Vercel for that build from the console.
 */

describe("the build's Settings values", () => {
  const filled = join(__dirname, ".built-filled.ts");
  afterEach(() => rmSync(filled, { force: true }));

  it("are laid over the server's environment when the module loads, noting what each held before", async () => {
    const source = readFileSync(join(__dirname, "../agent/lib/settings/built.ts"), "utf8");
    // The exact line scripts/build.mjs fills in.
    const line = "const BUILT: Readonly<Record<string, string>> = {};";
    expect(source).toContain(line);
    writeFileSync(filled, source.replace(line, `const BUILT: Readonly<Record<string, string>> = ${JSON.stringify({ BOT_ENGINES: "codex", BOT_JOB_COST_LIMIT_USD: "2" })};`));
    vi.stubEnv("BOT_JOB_COST_LIMIT_USD", "5");
    vi.stubEnv("BOT_SETTINGS_OVERLAY", undefined as unknown as string);
    delete process.env.BOT_SETTINGS_OVERLAY;
    await import(filled);
    expect(process.env.BOT_ENGINES).toBe("codex");
    expect(process.env.BOT_JOB_COST_LIMIT_USD).toBe("2");
    expect(JSON.parse(process.env.BOT_SETTINGS_OVERLAY ?? "{}")).toEqual({ BOT_ENGINES: null, BOT_JOB_COST_LIMIT_USD: "5" });
    delete process.env.BOT_ENGINES;
    vi.unstubAllEnvs();
  });

  it("are empty in git, so a build from the environment alone changes nothing", async () => {
    const { BUILT_SETTINGS } = await import("../agent/lib/settings/built");
    expect(BUILT_SETTINGS).toEqual({});
  });
});

describe("the engines on the Settings page", () => {
  it("are deployment settings that apply with the next build", async () => {
    const { SETTINGS_BY_ENV, normalizeValue } = await import("../agent/lib/settings/registry");
    for (const name of ["BOT_ENGINES", "BOT_ENGINE_BUILTINS", "BOT_ENGINE_NETWORK", "BOT_CLAUDE_CODE_MODEL", "BOT_CODEX_MODEL"]) {
      expect(SETTINGS_BY_ENV.get(name)).toMatchObject({ area: "Engines", scope: "deployment", tier: "rebuild" });
    }
    const engines = SETTINGS_BY_ENV.get("BOT_ENGINES")!;
    expect(normalizeValue(engines, "claude-code,codex")).toEqual({ ok: true, value: "claude-code,codex" });
    expect(normalizeValue(engines, "gemini")).toMatchObject({ ok: false });
    expect(SETTINGS_BY_ENV.get("BOT_DEPLOY_HOOK")).toMatchObject({ kind: { type: "secret" }, sensitive: true, where: "vercel" });
  });

  it("turn the shell and file tools on from the page's switch as from the environment", async () => {
    const { harnessBuiltins } = await import("../agent/lib/engines/harness-options");
    expect(harnessBuiltins({ BOT_ENGINE_BUILTINS: "on" })).toBe(true);
    expect(harnessBuiltins({ BOT_ENGINE_BUILTINS: "1" })).toBe(true);
    expect(harnessBuiltins({ BOT_ENGINE_BUILTINS: "off" })).toBe(false);
  });
});

describe("Rebuild now", () => {
  type Route = { method: string; path: string; handler: (request: Request, args: unknown) => Promise<Response> };
  const route = async (): Promise<Route> => {
    const ops = (await import("../agent/channels/ops")).default as unknown as { routes: Route[] };
    return ops.routes.find((candidate) => candidate.method === "POST" && candidate.path === "/bot/v1/settings/rebuild")!;
  };
  const post = async () => (await route()).handler(new Request("http://localhost/bot/v1/settings/rebuild", { method: "POST" }), { params: {} });

  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.stubEnv("BOT_STORE", "memory");
    vi.stubEnv("BOT_CONSOLE_TOKEN", "");
    vi.stubEnv("BOT_CONSOLE_TOKENS", "");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("asks Vercel's deploy hook for a build, once", async () => {
    const hook = "https://api.vercel.com/v1/integrations/deploy/prj_x/abc123";
    vi.stubEnv("BOT_DEPLOY_HOOK", hook);
    const called: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        called.push(`${init?.method} ${url}`);
        return new Response("{}", { status: 201 });
      }),
    );
    const response = await post();
    expect(response.status).toBe(200);
    expect(called).toEqual([`POST ${hook}`]);
  });

  it("calls nothing without a hook, or with an address that is not Vercel's deploy hook", async () => {
    const fetchSpy = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchSpy);
    expect((await post()).status).toBe(400);
    vi.stubEnv("BOT_DEPLOY_HOOK", "https://example.com/v1/integrations/deploy/x");
    expect((await post()).status).toBe(400);
    vi.stubEnv("BOT_DEPLOY_HOOK", "http://api.vercel.com/v1/integrations/deploy/x");
    expect((await post()).status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
