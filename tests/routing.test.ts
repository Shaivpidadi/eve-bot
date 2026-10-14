import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Whoever is asked does the work: a Bot asked in its thread, HQ asked on its
 * desk. Work moves to someone else only when the person named or tagged them.
 */

const WORKSPACE = "default";

async function team() {
  const bots = await import("../agent/lib/bots");
  const routing = await import("../agent/lib/routing");
  const ava = await bots.hireBot({ workspaceId: WORKSPACE, hiredBy: "operator", name: "Ava", role: "Email", persona: "Brief." });
  const atlas = await bots.hireBot({ workspaceId: WORKSPACE, hiredBy: "operator", name: "Atlas", role: "Generalist", persona: "Careful." });
  const route = (threadBotId: string | null, named: string | undefined, asked: string | null, automated = false) =>
    routing.routeWork({ workspaceId: WORKSPACE, threadBotId, named, asked, automated });
  return { bots, routing, ava, atlas, route };
}

describe("routeWork", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("BOT_STORE", "memory");
  });

  it("gives work asked in a Bot's thread to that Bot", async () => {
    const { ava, route } = await team();
    expect(await route(ava.id, undefined, "read my email")).toMatchObject({ ok: true, by: "thread", bot: { id: ava.id } });
    expect(await route(ava.id, "yourself", "read my email")).toMatchObject({ ok: true, bot: { id: ava.id } });
    expect(await route(ava.id, "Ava", "read my email")).toMatchObject({ ok: true, bot: { id: ava.id } });
  });

  it("gives work asked of HQ to HQ itself, not the generalist", async () => {
    const { route } = await team();
    const routed = await route(null, undefined, "read my email");
    expect(routed).toMatchObject({ ok: true, by: "thread", bot: { id: "hq", name: "HQ" } });
  });

  it("refuses a hand-off the person did not ask for", async () => {
    const { ava, route } = await team();
    const toAtlas = await route(ava.id, "Atlas", "read my email");
    expect(toAtlas.ok).toBe(false);
    if (!toAtlas.ok) expect(toAtlas.reason).toContain("Ava was asked");
    expect((await route(null, "Ava", "read my email")).ok).toBe(false);
    expect((await route(ava.id, "HQ", "read my email")).ok).toBe(false);
  });

  it("hands work on when the person names or tags the teammate", async () => {
    const { ava, atlas, route } = await team();
    expect(await route(ava.id, "Atlas", "@Atlas can you check the site?")).toMatchObject({ ok: true, by: "named", bot: { id: atlas.id } });
    expect(await route(null, "ava", "have Ava read my email")).toMatchObject({ ok: true, by: "named", bot: { id: ava.id } });
    expect(await route(ava.id, "HQ", "ask @HQ to summarise it")).toMatchObject({ ok: true, bot: { id: "hq" } });
  });

  it("trusts runtime turns, which carry no person's words", async () => {
    const { ava, atlas, route } = await team();
    expect(await route(ava.id, "Atlas", null, true)).toMatchObject({ ok: true, bot: { id: atlas.id } });
  });

  it("says so when the named teammate does not exist", async () => {
    const { route } = await team();
    expect(await route(null, "Zed", "@Zed do it")).toMatchObject({ ok: false });
  });

  it("keeps HQ off the roster and out of reach of retiring", async () => {
    const { bots } = await team();
    expect((await bots.getBot(WORKSPACE, "hq"))?.name).toBe("HQ");
    expect((await bots.listBots(WORKSPACE)).map((bot) => bot.id)).not.toContain("hq");
    expect(await bots.findBot(WORKSPACE, "HQ")).toBeNull();
    await expect(bots.retireBot(WORKSPACE, "hq")).rejects.toThrow();
  });
});

describe("mentions", () => {
  it("matches a name tagged or not, as a whole word", async () => {
    const { mentions } = await import("../agent/lib/routing");
    expect(mentions("@Ava pull the numbers", "Ava")).toBe(true);
    expect(mentions("ask ava, please", "Ava")).toBe(true);
    expect(mentions("Avalon is a place", "Ava")).toBe(false);
    expect(mentions("have QA v4cub check it", "QA v4cub")).toBe(true);
    expect(mentions("ping (Ava)", "Ava")).toBe(true);
    expect(mentions("nothing here", "Ava")).toBe(false);
  });
});
