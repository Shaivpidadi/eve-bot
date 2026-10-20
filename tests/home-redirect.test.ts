import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import { hasSignedInCookie, signedInCookie } from "../agent/lib/access";
import { proxy } from "../src/proxy";

/** The home page sends someone signed in to this deployment straight to the console. */

const visit = (path: string, cookie?: string, accept = "text/html") =>
  proxy(new NextRequest(`https://bot.example${path}`, { headers: { accept, ...(cookie ? { cookie } : {}) } }));

describe("the home page", () => {
  it("sends someone signed in to /bot, by the console's marker or Vercel Authentication", () => {
    expect(visit("/", "bot_signed_in=1").headers.get("location")).toBe("https://bot.example/bot");
    expect(visit("/", "_vercel_jwt=abc").status).toBe(307);
  });

  it("stays the home page for everyone else, with ?site, for agents, and on the other public pages", () => {
    expect(visit("/").headers.get("location")).toBeNull();
    expect(visit("/?site", "bot_signed_in=1").headers.get("location")).toBeNull();
    expect(visit("/about", "bot_signed_in=1").headers.get("location")).toBeNull();
    expect(visit("/", "bot_signed_in=1", "text/markdown").headers.get("content-type")).toContain("text/markdown");
  });
});

describe("the marker", () => {
  it("covers the whole site, holds no token, and is cleared on sign-out", () => {
    const request = new Request("https://bot.example/bot/v1/session");
    expect(signedInCookie(true, request)).toMatch(/^bot_signed_in=1; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+; Secure$/);
    expect(signedInCookie(false, request)).toContain("Max-Age=0");
    expect(hasSignedInCookie(new Request("https://bot.example/", { headers: { cookie: "a=b; bot_signed_in=1" } }))).toBe(true);
    expect(hasSignedInCookie(new Request("https://bot.example/", { headers: { cookie: "bot_signed_in=" } }))).toBe(false);
  });
});
