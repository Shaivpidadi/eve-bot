import { beforeEach, describe, expect, it, vi } from "vitest";

/** Events forwarded by Vercel Connect: only verified ones get in, each kept once, with no credential kept. */

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv("BOT_STORE", "memory");
});

const linear = (delivery: string) =>
  new Headers({ "linear-delivery": delivery, "linear-event": "Issue", authorization: "Bearer secret-oidc", "content-type": "application/json" });

describe("connector triggers", () => {
  it("lets in only what the verifier accepts, failing closed on an error", async () => {
    const { verifiedTrigger } = await import("../agent/lib/triggers");
    const request = new Request("https://bot.example/bot/v1/hooks/connect", { method: "POST" });
    expect(await verifiedTrigger(request, "{}", async () => true)).toBe(true);
    expect(await verifiedTrigger(request, "{}", async () => false)).toBe(false);
    expect(
      await verifiedTrigger(request, "{}", async () => {
        throw new Error("bad token");
      }),
    ).toBe(false);
  });

  it("keeps a delivery once, by the provider's delivery id, without its authorization", async () => {
    const { acceptTrigger, recentTriggers } = await import("../agent/lib/triggers");
    const body = JSON.stringify({ action: "create", type: "Issue", data: { title: "Hello" } });
    const first = await acceptTrigger(linear("d-1"), body);
    expect(first.fresh).toBe(true);
    expect(first.receipt).toMatchObject({ id: "d-1", provider: "linear", body: { type: "Issue" } });
    expect(first.receipt.headers).not.toHaveProperty("authorization");
    expect((await acceptTrigger(linear("d-1"), body)).fresh).toBe(false);
    expect((await acceptTrigger(linear("d-2"), body)).fresh).toBe(true);
    expect((await recentTriggers()).map((receipt) => receipt.id).sort()).toEqual(["d-1", "d-2"]);
  });

  it("names a delivery with no id of its own by its body", async () => {
    const { deliveryId } = await import("../agent/lib/triggers");
    const plain = new Headers();
    expect(deliveryId(plain, "a")).toBe(deliveryId(plain, "a"));
    expect(deliveryId(plain, "a")).not.toBe(deliveryId(plain, "b"));
    expect(deliveryId(new Headers({ "linear-delivery": "../../etc" }), "x")).toBe("etc");
  });
});
