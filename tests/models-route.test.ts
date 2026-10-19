import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Models page's API: the report shows each role, Gateway's list and what
 * will go wrong; a save is checked, refused in plain words, or locked by the
 * deployment. Gateway's list is a stand-in.
 */

vi.mock("../agent/lib/computer-backup", () => ({
  ensureComputerRestored: vi.fn(async () => undefined),
  checkpointComputer: vi.fn(async () => undefined),
}));
vi.mock("../agent/subagents/teammate/lib/browser", () => ({ bindScreen: vi.fn(async () => undefined) }));
vi.mock("../agent/lib/computer/shell", async (original) => ({
  ...(await original<typeof import("../agent/lib/computer/shell")>()),
  stopRunCommands: vi.fn(async () => 0),
}));

const LIST = {
  data: [
    { id: "free/eyes", name: "Eyes", type: "language", tags: ["tool-use", "vision", "structured-output"], modalities: { input: ["text", "image"] }, context_window: 1000000, zdr: "none", pricing: { input: "0", output: "0" } },
    { id: "free/text", name: "Text", type: "language", tags: ["tool-use"], modalities: { input: ["text"] }, context_window: 256000, zdr: "none", pricing: { input: "0", output: "0" } },
    { id: "paid/smart", name: "Smart", type: "language", tags: ["tool-use", "vision", "structured-output", "reasoning"], modalities: { input: ["text", "image"] }, context_window: 200000, zdr: "all", pricing: { input: "0.000003", output: "0.000015" } },
  ],
};

type Route = { method: string; path: string; handler: (request: Request, args: unknown) => Promise<Response> };

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv("BOT_STORE", "memory");
  vi.stubEnv("BOT_COMPUTER_KEY", "k".repeat(40));
  vi.stubEnv("VERCEL", "");
  vi.stubEnv("BOT_CONSOLE_TOKEN", "");
  vi.stubEnv("BOT_CONSOLE_TOKENS", "");
  vi.stubEnv("BOT_CONSOLE_OPEN", "");
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("BOT_MODEL_BASE_URL", "");
  vi.stubEnv("BOT_HQ_MODEL", "");
  vi.stubEnv("BOT_TEAMMATE_MODEL", "");
  vi.stubEnv("BOT_ZDR", "");
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => (String(url).includes("/v1/models") ? new Response(JSON.stringify(LIST)) : new Response("{}", { status: 404 }))));
});

async function call(method: "GET" | "PUT", body?: unknown) {
  const ops = (await import("../agent/channels/ops")).default as unknown as { routes: Route[] };
  const route = ops.routes.find((candidate) => candidate.method === method && candidate.path === "/bot/v1/models")!;
  const response = await route.handler(
    new Request("http://localhost/bot/v1/models", { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
    { params: {} },
  );
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

describe("GET /bot/v1/models", () => {
  it("shows every role on its default, and Gateway's list with free models first", async () => {
    const { status, body } = await call("GET");
    expect(status).toBe(200);
    expect(body.editable).toBe(true);
    expect(body.roles.map((role: { role: string }) => role.role)).toEqual(["hq", "standard", "quick", "deep", "helper"]);
    expect(body.roles[0]).toMatchObject({ setting: null, default: "anthropic/claude-sonnet-5", resolved: { source: "default" } });
    expect(body.catalog.models.map((model: { id: string }) => model.id)).toEqual(["free/eyes", "free/text", "paid/smart"]);
  });
});

describe("PUT /bot/v1/models", () => {
  it("saves a choice and warns what will go wrong with it", async () => {
    const { status, body } = await call("PUT", { roles: { standard: "free/text", hq: "paid/smart" } });
    expect(status).toBe(200);
    const standard = body.roles.find((role: { role: string }) => role.role === "standard");
    expect(standard.resolved).toMatchObject({ id: "free/text", source: "setting" });
    expect(standard.warnings).toEqual(["This model can't see screenshots, so browser steps will fail."]);
    expect(body.roles.find((role: { role: string }) => role.role === "hq").warnings).toEqual([]);
  });

  it("puts everything on a free model with the switch, and refuses a paid one then", async () => {
    const on = await call("PUT", { freeOnly: true });
    expect(on.body.roles.every((role: { resolved: { free: boolean } }) => role.resolved.free)).toBe(true);
    expect(on.body.freeDefault).toMatchObject({ id: "free/eyes" });
    const paid = await call("PUT", { roles: { hq: "paid/smart" } });
    expect(paid).toMatchObject({ status: 422, body: { error: expect.stringContaining("not free") } });
  });

  it("refuses a body it cannot read", async () => {
    expect((await call("PUT", { roles: { boss: "paid/smart" } })).status).toBe(400);
    expect((await call("PUT", { freeOnly: "yes" })).status).toBe(400);
  });

  it("is closed when the deployment locks models", async () => {
    vi.stubEnv("BOT_MODELS_EDITABLE", "off");
    expect((await call("PUT", { roles: { hq: "paid/smart" } })).status).toBe(403);
    expect((await call("GET")).body.editable).toBe(false);
  });
});
