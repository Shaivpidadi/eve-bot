import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Who does the work: whoever the person tagged; otherwise the Bot whose role
 * fits (Jev's call, faked here); otherwise HQ on its desk, or the thread's own
 * Bot in its thread.
 */

const WORKSPACE = "default";

type Fit = import("../agent/lib/routing").Fit;

async function team() {
  const bots = await import("../agent/lib/bots");
  const routing = await import("../agent/lib/routing");
  const ava = await bots.hireBot({ workspaceId: WORKSPACE, hiredBy: "operator", name: "Ava", role: "Email assistant", persona: "Brief." });
  const atlas = await bots.hireBot({ workspaceId: WORKSPACE, hiredBy: "operator", name: "Atlas", role: "Generalist", persona: "Careful." });
  const route = (
    threadBotId: string | null,
    named: string | undefined,
    asked: string | null,
    fit: Fit | null = null,
    automated = false,
  ) => routing.routeWork({ workspaceId: WORKSPACE, threadBotId, named, asked, task: asked ?? "", automated, fit: async () => fit });
  const sure = (choice: string, probabilities: Record<string, number> = { [choice]: 0.9 }): Fit => ({ choice, probabilities, confident: true });
  return { bots, routing, ava, atlas, route, sure };
}

describe("routeWork", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("BOT_STORE", "memory");
  });

  it("gives work to whoever the person tagged or named", async () => {
    const { ava, atlas, route, sure } = await team();
    expect(await route(null, undefined, "@Atlas check the site", sure(ava.id))).toMatchObject({ ok: true, by: "named", bot: { id: atlas.id } });
    expect(await route(null, "Ava", "have Ava read my email")).toMatchObject({ ok: true, by: "named", bot: { id: ava.id } });
    expect(await route(ava.id, "Atlas", "@Atlas can you check the site?")).toMatchObject({ ok: true, by: "named", bot: { id: atlas.id } });
    expect(await route(ava.id, undefined, "ask @HQ to summarise it")).toMatchObject({ ok: true, by: "named", bot: { id: "hq" } });
  });

  it("on HQ's desk, picks the Bot whose role fits without being told", async () => {
    const { ava, route, sure } = await team();
    expect(await route(null, undefined, "read my email", sure(ava.id))).toMatchObject({ ok: true, by: "fit", bot: { id: ava.id } });
  });

  it("on HQ's desk, has HQ do it when no Bot fits", async () => {
    const { route, sure } = await team();
    expect(await route(null, undefined, "book me a table", sure("none"))).toMatchObject({ ok: true, by: "hq", bot: { id: "hq", name: "HQ" } });
    expect(await route(null, undefined, "book me a table", null)).toMatchObject({ ok: true, by: "hq", bot: { id: "hq" } });
  });

  it("on HQ's desk, lets the model's own pick stand when Jev cannot say", async () => {
    const { ava, route } = await team();
    expect(await route(null, "Ava", "read my email", null)).toMatchObject({ ok: true, bot: { id: ava.id } });
    expect(await route(null, "Ava", "read my email", { choice: "none", probabilities: {}, confident: false })).toMatchObject({ ok: true, bot: { id: ava.id } });
  });

  it("in a Bot's thread, keeps the work with that Bot, not the generalist", async () => {
    const { ava, atlas, route, sure } = await team();
    expect(await route(ava.id, undefined, "read my email", null)).toMatchObject({ ok: true, by: "thread", bot: { id: ava.id } });
    // The model reaching for Atlas unasked does not move it.
    expect(await route(ava.id, "Atlas", "read my email", null)).toMatchObject({ ok: true, by: "thread", bot: { id: ava.id } });
    // Nor does a fit that still rates Ava.
    expect(await route(ava.id, undefined, "read my email", sure(atlas.id, { [atlas.id]: 0.6, [ava.id]: 0.35 }))).toMatchObject({ bot: { id: ava.id } });
    // Nor does "nothing fits": Ava was asked.
    expect(await route(ava.id, undefined, "book me a table", sure("none"))).toMatchObject({ bot: { id: ava.id } });
  });

  it("in a Bot's thread, moves work only when another Bot clearly fits much better", async () => {
    const { ava, atlas, route, sure } = await team();
    expect(await route(atlas.id, undefined, "triage my inbox", sure(ava.id, { [ava.id]: 0.92, [atlas.id]: 0.05 }))).toMatchObject({ ok: true, by: "fit", bot: { id: ava.id } });
  });

  it("trusts runtime turns, which carry no person's words", async () => {
    const { ava, atlas, route } = await team();
    expect(await route(ava.id, "Atlas", null, null, true)).toMatchObject({ ok: true, bot: { id: atlas.id } });
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
