import { afterEach, describe, expect, it, vi } from "vitest";

import { forgetVersion, newer, ownVersion, updateLink, versionReport } from "../agent/lib/version";

describe("version", () => {
  afterEach(() => {
    forgetVersion();
    vi.unstubAllEnvs();
  });

  it("compares dot-separated versions numerically", () => {
    expect(newer("0.2.0", "0.1.0")).toBe(true);
    expect(newer("0.10.0", "0.9.3")).toBe(true);
    expect(newer("1.0.0", "0.99.99")).toBe(true);
    expect(newer("0.2.0", "0.2.0")).toBe(false);
    expect(newer("0.1.9", "0.2.0")).toBe(false);
    expect(newer("v0.3.0", "0.2.0")).toBe(true);
    expect(newer("garbage", "0.2.0")).toBe(false);
  });

  it("reads its own version from the package, and says when the original is newer", async () => {
    expect(ownVersion()).toMatch(/^\d+\.\d+\.\d+$/);
    forgetVersion();
    vi.stubEnv("BOT_VERSION", "0.2.0");
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "abcdef1234567");
    const github = (async () => new Response(JSON.stringify({ name: "eve-bot", version: "0.3.1" }), { status: 200 })) as unknown as typeof fetch;
    const report = await versionReport(github);
    expect(report).toEqual({ version: "0.2.0", commit: "abcdef1", latest: "0.3.1", updateAvailable: true, howToUpdate: expect.stringContaining("#keeping-it-up-to-date"), runsItself: false });
    // The answer is kept, so the console asking every few seconds costs GitHub nothing.
    let calls = 0;
    const counting = (async () => (calls += 1, new Response("{}", { status: 200 }))) as unknown as typeof fetch;
    await versionReport(counting);
    expect(calls).toBe(0);
  });

  it("stays quiet when GitHub cannot be asked, or when asked not to", async () => {
    vi.stubEnv("BOT_VERSION", "0.2.0");
    const down = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    expect(await versionReport(down)).toMatchObject({ latest: null, updateAvailable: false });
    forgetVersion();
    vi.stubEnv("BOT_VERSION", "0.2.0");
    vi.stubEnv("BOT_UPDATE_CHECK", "off");
    let calls = 0;
    const counting = (async () => (calls += 1, new Response("{}", { status: 200 }))) as unknown as typeof fetch;
    expect(await versionReport(counting)).toMatchObject({ latest: null, updateAvailable: false });
    expect(calls).toBe(0);
  });

  it("points a copy at its own sync workflow, and everyone else at the notes", () => {
    expect(updateLink({ VERCEL_GIT_REPO_OWNER: "ann", VERCEL_GIT_REPO_SLUG: "eve-eve-bot" } as unknown as NodeJS.ProcessEnv)).toEqual({
      url: "https://github.com/ann/eve-eve-bot/actions/workflows/sync-upstream.yml",
      runsItself: true,
    });
    expect(updateLink({ VERCEL_GIT_REPO_OWNER: "Shaivpidadi", VERCEL_GIT_REPO_SLUG: "eve-bot" } as unknown as NodeJS.ProcessEnv).runsItself).toBe(false);
    expect(updateLink({} as unknown as NodeJS.ProcessEnv).runsItself).toBe(false);
    expect(updateLink({ VERCEL_GIT_REPO_OWNER: "ann", VERCEL_GIT_REPO_SLUG: "x", VERCEL_GIT_PROVIDER: "gitlab" } as unknown as NodeJS.ProcessEnv).runsItself).toBe(false);
  });
});
