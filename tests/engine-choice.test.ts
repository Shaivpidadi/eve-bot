import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Choosing what runs a Bot's jobs when it is hired or edited: eve unless the
 * person picks an engine the owner turned on; refused, in words, everywhere
 * else. The board tells the console which engines may be picked.
 */

vi.mock("../agent/lib/computer-backup", () => ({
  ensureComputerRestored: vi.fn(async () => undefined),
  checkpointComputer: vi.fn(async () => undefined),
}));
vi.mock("../agent/subagents/teammate/lib/browser", () => ({ bindScreen: vi.fn(async () => undefined) }));
vi.mock("../agent/lib/intro", () => ({ writeIntro: vi.fn(async () => null) }));

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
  vi.stubEnv("BOT_ENGINES", "");
  vi.stubEnv("BOT_ZDR", "");
  vi.stubEnv("BOT_INFERENCE_REGION", "");
  vi.stubEnv("BOT_MODEL_BASE_URL", "");
});

async function call(method: "POST" | "PATCH", path: string, body: unknown) {
  const ops = (await import("../agent/channels/ops")).default as unknown as { routes: Route[] };
  const pattern = path.startsWith("/bot/v1/bots/") ? "/bot/v1/bots/:botId" : path;
  const route = ops.routes.find((candidate) => candidate.method === method && candidate.path === pattern)!;
  const response = await route.handler(new Request(`http://localhost${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), {
    params: { botId: path.split("/").at(-1) },
    waitUntil: () => undefined,
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const hire = { name: "Cody", role: "Writes small scripts", persona: "Careful, and says what it could not check." };

describe("choosing an engine", () => {
  it("offers only eve until the owner turns another on", async () => {
    const { engineChoices } = await import("../agent/lib/engines");
    expect(engineChoices("default", {})).toEqual(["eve"]);
    expect(engineChoices("default", { BOT_ENGINES: "claude-code,codex" })).toEqual(["eve", "claude-code", "codex"]);
    expect(engineChoices("tenant", { BOT_ENGINES: "claude-code" })).toEqual(["eve"]);
    expect(engineChoices("default", { BOT_ENGINES: "codex", BOT_ZDR: "1" })).toEqual(["eve"]);
  });

  it("hires on eve by default, and on another engine only where it is on", async () => {
    const plain = await call("POST", "/bot/v1/bots", hire);
    expect(plain.status).toBe(201);
    const { getBot } = await import("../agent/lib/bots");
    const { engineOf } = await import("../agent/lib/engines");
    expect(engineOf(await getBot("default", (plain.body.bot as { id: string }).id))).toBe("eve");

    expect(await call("POST", "/bot/v1/bots", { ...hire, name: "Rex", engine: "codex" })).toMatchObject({ status: 400, body: { error: expect.stringContaining("off on this deployment") } });
    expect(await call("POST", "/bot/v1/bots", { ...hire, name: "Rex", engine: "vim" })).toMatchObject({ status: 400 });

    vi.stubEnv("BOT_ENGINES", "codex");
    const coder = await call("POST", "/bot/v1/bots", { ...hire, name: "Rex", engine: "codex" });
    expect(coder.status).toBe(201);
    const id = (coder.body.bot as { id: string }).id;
    expect((await getBot("default", id))?.engine).toBe("codex");

    // Moved back to eve from its profile.
    expect((await call("PATCH", `/bot/v1/bots/${id}`, { engine: "eve" })).status).toBe(200);
    expect(engineOf(await getBot("default", id))).toBe("eve");
  });

  it("tells the console what may be picked, and what each Bot runs on", async () => {
    vi.stubEnv("BOT_ENGINES", "claude-code");
    await call("POST", "/bot/v1/bots", { ...hire, engine: "claude-code" });
    const { buildBoard } = await import("../agent/lib/board");
    const board = await buildBoard("default");
    expect(board.engines).toEqual(["eve", "claude-code"]);
    expect(board.members.find((member) => member.name === "Cody")?.profile?.engine).toBe("claude-code");
  });
});
