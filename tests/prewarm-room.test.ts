import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RoomStore } from "../src/console/room-store";

/**
 * A thread's session is made ready while its first message is being typed
 * (eve 0.82's `create()` on a channel address), so the durable run is up by
 * the time the message is sent. It runs no turn, leaves a room that has a
 * session alone, and never stands in the way of the first message.
 */

type Route = { method: string; path: string; handler: (request: Request, args: unknown) => Promise<Response> };
const prewarmRoute = async (): Promise<Route> => {
  const ops = (await import("../agent/channels/ops")).default as unknown as { routes: Route[] };
  const route = ops.routes.find((candidate) => candidate.method === "POST" && candidate.path === "/bot/v1/rooms/:room/prewarm");
  expect(route).toBeDefined();
  return route!;
};
const call = (route: Route, from: (address: string) => unknown) =>
  route.handler(new Request("http://localhost/bot/v1/rooms/desk/prewarm", { method: "POST" }), { from, params: { room: "desk" } });

describe("POST /bot/v1/rooms/:room/prewarm", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("BOT_STORE", "memory");
    vi.stubEnv("BOT_CONSOLE_TOKEN", "");
    vi.stubEnv("BOT_CONSOLE_TOKENS", "");
  });

  it("creates the room's session at the room's address, as the person who will send, without a turn", async () => {
    const route = await prewarmRoute();
    const created: { address: string; auth: unknown }[] = [];
    const from = (address: string) => ({
      create: async (options: { auth: unknown }) => {
        created.push({ address, auth: options.auth });
        return { created: true, session: { id: "sess_warm" } };
      },
      send: vi.fn(),
    });
    const response = await call(route, from);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ room: "desk", sessionId: "sess_warm", created: true });
    // The same address and the same principal a message to this room would use.
    const { roomAddress } = await import("../agent/lib/rooms");
    expect(created).toHaveLength(1);
    expect(created[0]?.address).toBe(roomAddress("default", "desk", 0));
    expect(created[0]?.auth).toMatchObject({ authenticator: "bot-console", principalType: "user" });
  });

  it("leaves a room that already has a session as it is", async () => {
    const route = await prewarmRoute();
    const response = await call(route, () => ({ create: async () => ({ created: false, session: { id: "sess_live" } }) }));
    expect(await response.json()).toEqual({ room: "desk", sessionId: "sess_live", created: false });
  });

  it("gives way to the first message when the room's session is stranded", async () => {
    const route = await prewarmRoute();
    const { SessionStrandedError } = await import("eve/channels");
    const stranded = Object.assign(new Error("stranded"), { name: "SessionStrandedError" });
    const isStranded = vi.spyOn(SessionStrandedError, "is").mockImplementation((error) => error === stranded);
    const response = await call(route, () => ({
      create: async () => {
        throw stranded;
      },
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ room: "desk", sessionId: null, created: false });
    isStranded.mockRestore();
  });
});

describe("the console's thread", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("asks for its session once when typing starts, and again only after it is started over", async () => {
    const asked: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        asked.push(`${init?.method ?? "GET"} ${url}`);
        return new Response(JSON.stringify({ created: true }), { status: 200 });
      }),
    );
    const store = new RoomStore("desk");
    store.prewarm();
    store.prewarm();
    store.prewarm();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(asked.filter((line) => line.endsWith("/prewarm"))).toEqual(["POST /bot/v1/rooms/desk/prewarm"]);
    store.restart();
    store.prewarm();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(asked.filter((line) => line.endsWith("/prewarm"))).toHaveLength(2);
  });
});
