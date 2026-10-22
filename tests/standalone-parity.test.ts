import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A standalone server shows and checks what applies to it: Settings offers only
 * what works on its models and its computer, the sign-in page's setup check
 * asks Docker and the model endpoint, and npm start's worker gets in with the
 * secret it made.
 */

type Route = { method: string; path: string; handler: (request: Request, args: unknown) => Promise<Response> };
async function shown(): Promise<Set<string>> {
  const ops = (await import("../agent/channels/ops")).default as unknown as { routes: Route[] };
  const route = ops.routes.find((candidate) => candidate.method === "GET" && candidate.path === "/bot/v1/settings")!;
  const body = (await (await route.handler(new Request("http://localhost/bot/v1/settings"), { params: {} })).json()) as { settings: { env: string }[] };
  return new Set(body.settings.map((setting) => setting.env));
}

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.stubEnv("BOT_STORE", "memory");
  vi.stubEnv("BOT_CONSOLE_TOKEN", "");
  vi.stubEnv("BOT_CONSOLE_TOKENS", "");
  vi.stubEnv("VERCEL", "");
  vi.stubEnv("BOT_MODEL_BASE_URL", "");
  vi.stubEnv("BOT_COMPUTER", "local");
  vi.stubEnv("BOT_COMPUTER_LOCAL", "");
});
afterEach(() => vi.unstubAllEnvs());

describe("Settings on a standalone server", () => {
  it("offers what AI Gateway does when the models come through it, and not the endpoint's backstops", async () => {
    const settings = await shown();
    for (const name of ["BOT_JEV", "BOT_MEMORY_EMBEDDINGS", "BOT_ZDR", "BOT_INFERENCE_REGION"]) expect(settings.has(name), name).toBe(true);
    for (const name of ["BOT_MODEL_PRICES", "BOT_HQ_INPUT_TOKEN_LIMIT"]) expect(settings.has(name), name).toBe(false);
  });

  it("on its own endpoint, offers the endpoint's backstops, and of AI Gateway's only what works off it", async () => {
    vi.stubEnv("BOT_MODEL_BASE_URL", "http://localhost:11434/v1");
    const settings = await shown();
    for (const name of ["BOT_MODEL_PRICES", "BOT_HQ_INPUT_TOKEN_LIMIT", "BOT_JOB_OUTPUT_TOKEN_LIMIT"]) expect(settings.has(name), name).toBe(true);
    for (const name of ["BOT_ZDR", "BOT_INFERENCE_REGION", "BOT_HQ_REASONING"]) expect(settings.has(name), name).toBe(false);
    // Jev and memory by meaning run on your own provider too.
    for (const name of ["BOT_JEV", "BOT_JEV_MODEL", "BOT_MEMORY_EMBEDDINGS", "BOT_MEMORY_EMBEDDING_MODEL"]) expect(settings.has(name), name).toBe(true);
  });

  it("does not offer what a Docker computer can't do: CPUs, Sandbox prices, a list of sites", async () => {
    const settings = await shown();
    for (const name of ["BOT_SANDBOX_VCPUS", "BOT_COMPUTER_USD_PER_HOUR", "BOT_COMPUTER_USD_PER_CPU_HOUR", "BOT_SANDBOX_ALLOW_DOMAINS"]) expect(settings.has(name), name).toBe(false);
    vi.resetModules();
    vi.stubEnv("BOT_COMPUTER_LOCAL", "microsandbox");
    expect((await shown()).has("BOT_SANDBOX_ALLOW_DOMAINS")).toBe(true);
  });
});

describe("the setup check", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const fakeDocker = (answers: boolean) => {
    const dir = mkdtempSync(join(tmpdir(), "docker-"));
    dirs.push(dir);
    const cli = join(dir, "docker");
    writeFileSync(cli, answers ? "#!/bin/sh\necho 27.0.1\n" : "#!/bin/sh\nexit 1\n");
    chmodSync(cli, 0o755);
    return cli;
  };

  it.skipIf(process.platform === "win32")("asks Docker whether it answers", async () => {
    const { dockerReady } = await import("../agent/lib/setup-probe");
    expect(await dockerReady({ EVE_DOCKER_PATH: fakeDocker(true) })).toBe(true);
    expect(await dockerReady({ EVE_DOCKER_PATH: fakeDocker(false) })).toBe(false);
    expect(await dockerReady({ EVE_DOCKER_PATH: join(tmpdir(), "no-such-docker") })).toBe(false);
  });

  it("asks the model endpoint for its list, and on AI Gateway looks for a credential", async () => {
    const { modelsReady } = await import("../agent/lib/setup-probe");
    expect(await modelsReady({})).toEqual({ via: "gateway", ready: false });
    expect(await modelsReady({ AI_GATEWAY_API_KEY: "k" })).toEqual({ via: "gateway", ready: true });
    vi.resetModules();
    vi.stubEnv("BOT_MODEL_BASE_URL", "http://localhost:11434/v1");
    const asked: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (asked.push(url), new Response("{}", { status: 200 }))));
    const probe = await import("../agent/lib/setup-probe");
    expect(await probe.modelsReady()).toEqual({ via: "endpoint", ready: true });
    expect(asked).toEqual(["http://localhost:11434/v1/models"]);
  });
});

describe("npm start's worker", () => {
  it("gets in with the secret it made for this start", async () => {
    vi.stubEnv("BOT_INTERNAL_SECRET", "s".repeat(43));
    const { isInternal, INTERNAL_HEADER } = await import("../agent/lib/self");
    expect(await isInternal(new Request("http://localhost/", { headers: { [INTERNAL_HEADER]: "s".repeat(43) } }))).toBe(true);
    expect(await isInternal(new Request("http://localhost/", { headers: { [INTERNAL_HEADER]: "wrong" } }))).toBe(false);
  });
});

describe("settings that used to be environment only", () => {
  const owner = { workspaceId: "default", owner: true, by: "owner" };

  it("read your provider's API key from Settings on each call", async () => {
    vi.stubEnv("BOT_COMPUTER_KEY", "k".repeat(40));
    const { saveSettings } = await import("../agent/lib/settings/store");
    const { endpointKey } = await import("../agent/lib/models");
    expect(await endpointKey()).toBeUndefined();
    expect(await saveSettings(owner, { BOT_MODEL_API_KEY: "sk-saved" })).toMatchObject({ ok: true });
    expect(await endpointKey()).toBe("sk-saved");
  });

  it("hand a saved Postgres address to the server when it starts, and never to the build", async () => {
    vi.stubEnv("BOT_COMPUTER_KEY", "k".repeat(40));
    const { rebuildPlan, saveSettings } = await import("../agent/lib/settings/store");
    expect(await saveSettings(owner, { WORKFLOW_POSTGRES_URL: "postgres://u:p@db:5432/world", BOT_TICK_CRON: "* * * * *" })).toMatchObject({ ok: true });
    const plan = await rebuildPlan({});
    expect(plan.secrets).toEqual({ WORKFLOW_POSTGRES_URL: "postgres://u:p@db:5432/world" });
    expect(plan.overlay).toEqual({ BOT_TICK_CRON: "* * * * *" });
    expect(JSON.stringify(plan.overlay)).not.toContain("postgres://");
  });

  it("refuse a conversation store that is not installed here", async () => {
    const ops = (await import("../agent/channels/ops")).default as unknown as { routes: Route[] };
    const route = ops.routes.find((candidate) => candidate.method === "PUT" && candidate.path === "/bot/v1/settings")!;
    const put = (changes: Record<string, unknown>) => route.handler(new Request("http://localhost/bot/v1/settings", { method: "PUT", body: JSON.stringify({ changes }) }), { params: {} });
    const refused = await put({ BOT_WORKFLOW_WORLD: "@workflow/world-postgres" });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toMatch(/not installed/);
  });
});
