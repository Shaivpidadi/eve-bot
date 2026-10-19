import { beforeEach, describe, expect, it, vi } from "vitest";

/** The Settings page's API: what the caller may see, and saves checked by the registry and the owner rule. */

vi.mock("../agent/lib/computer-backup", () => ({
  ensureComputerRestored: vi.fn(async () => undefined),
  checkpointComputer: vi.fn(async () => undefined),
}));
vi.mock("../agent/subagents/teammate/lib/browser", () => ({ bindScreen: vi.fn(async () => undefined) }));
vi.mock("../agent/lib/computer/shell", async (original) => ({
  ...(await original<typeof import("../agent/lib/computer/shell")>()),
  stopRunCommands: vi.fn(async () => 0),
}));

type Route = { method: string; path: string; handler: (request: Request, args: unknown) => Promise<Response> };

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv("BOT_STORE", "memory");
  vi.stubEnv("BOT_COMPUTER_KEY", "k".repeat(40));
  vi.stubEnv("VERCEL", "");
  vi.stubEnv("BOT_CONSOLE_TOKEN", "owner-token");
  vi.stubEnv("BOT_CONSOLE_TOKENS", "tenant-token=acme");
  vi.stubEnv("BOT_CONSOLE_OPEN", "");
  vi.stubEnv("NODE_ENV", "test");
});

async function call(method: "GET" | "PUT", token: string, body?: unknown) {
  const ops = (await import("../agent/channels/ops")).default as unknown as { routes: Route[] };
  const route = ops.routes.find((candidate) => candidate.method === method && candidate.path === "/bot/v1/settings")!;
  const response = await route.handler(
    new Request("http://localhost/bot/v1/settings", { method, headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
    { params: {} },
  );
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

describe("/bot/v1/settings", () => {
  it("gives the owner every setting and a tenant only its workspace's", async () => {
    const asOwner = await call("GET", "owner-token");
    expect(asOwner).toMatchObject({ status: 200, body: { owner: true, editable: true } });
    const asTenant = await call("GET", "tenant-token");
    expect(asTenant.body.owner).toBe(false);
    expect(asTenant.body.settings.length).toBeLessThan(asOwner.body.settings.length);
    expect(asTenant.body.settings.every((setting: { scope: string }) => setting.scope === "workspace")).toBe(true);
  });

  it("saves the owner's change and refuses a tenant's change to the deployment", async () => {
    const saved = await call("PUT", "owner-token", { changes: { BOT_BROWSER_PAGE_CHARS: 9000 } });
    expect(saved.status).toBe(200);
    expect(saved.body.settings.find((setting: { env: string }) => setting.env === "BOT_BROWSER_PAGE_CHARS")).toMatchObject({ value: "9000", source: "setting" });
    expect(await call("PUT", "tenant-token", { changes: { BOT_BROWSER_PAGE_CHARS: 9000 } })).toMatchObject({ status: 403 });
    expect(await call("PUT", "tenant-token", { changes: { BOT_TIMEZONE: "Asia/Tokyo" } })).toMatchObject({ status: 200 });
    expect((await call("PUT", "owner-token", { nope: 1 })).status).toBe(400);
  });
});
