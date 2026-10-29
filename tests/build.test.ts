import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { buildId, overrideBuildId, resetBuildId, UNKNOWN_BUILD } from "../agent/lib/build";

/**
 * A build id must be the same across restarts of the same code and different
 * for different code, because a local lease from another build is dead.
 */

function root(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "bot-build-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

describe("buildId", () => {
  it("is the deployment on Vercel", () => {
    expect(buildId({ env: { VERCEL_DEPLOYMENT_ID: "dpl_123" }, cwd: root() })).toBe("vercel:dpl_123");
  });

  it("is the development generation under eve dev, and changes when it does", () => {
    const pointer = (snapshot: string) => JSON.stringify({ snapshotRoot: `/app/.eve/dev-runtime/snapshots/${snapshot}` });
    const dir = root({ ".eve/dev-runtime/current.json": pointer("gen-one") });
    expect(buildId({ env: {}, cwd: dir })).toBe("dev:gen-one");
    expect(buildId({ env: {}, cwd: dir })).toBe("dev:gen-one");
    writeFileSync(join(dir, ".eve/dev-runtime/current.json"), pointer("gen-two"));
    expect(buildId({ env: {}, cwd: dir })).toBe("dev:gen-two");
  });

  it("is the build date of a built server", () => {
    const dir = root({ ".output/nitro.json": JSON.stringify({ date: "2026-10-13T12:00:00.000Z" }) });
    expect(buildId({ env: {}, cwd: dir })).toBe("build:2026-10-13T12:00:00.000Z");
  });

  it("prefers the override, then Vercel, then dev, then the build", () => {
    const dir = root({
      ".eve/dev-runtime/current.json": JSON.stringify({ snapshotRoot: "/x/gen" }),
      ".output/nitro.json": JSON.stringify({ date: "d" }),
    });
    expect(buildId({ env: { BOT_BUILD_ID: "pinned", VERCEL_DEPLOYMENT_ID: "dpl" }, cwd: dir })).toBe("pinned");
    expect(buildId({ env: { VERCEL_DEPLOYMENT_ID: "dpl" }, cwd: dir })).toBe("vercel:dpl");
    expect(buildId({ env: {}, cwd: dir })).toBe("dev:gen");
  });

  it("is the build date of a served build even with a dev pointer left from an earlier npm run dev", () => {
    const dir = root({
      ".eve/dev-runtime/current.json": JSON.stringify({ snapshotRoot: "/x/old-gen" }),
      ".output/nitro.json": JSON.stringify({ date: "2026-10-29T13:49:49.177Z" }),
    });
    expect(buildId({ env: { NODE_ENV: "production" }, cwd: dir })).toBe("build:2026-10-29T13:49:49.177Z");
  });

  it("reports the QA override from every copy of the module in the process", async () => {
    resetBuildId();
    vi.resetModules();
    // A second copy, as eve's workflow-step bundle has: its own cache, already filled.
    const other = await import("../agent/lib/build");
    expect(other.buildId).not.toBe(buildId);
    other.buildId();
    buildId();
    overrideBuildId("qa-bumped");
    expect(buildId()).toBe("qa-bumped");
    expect(other.buildId()).toBe("qa-bumped");
    resetBuildId();
    expect(buildId()).not.toBe("qa-bumped");
  });

  it("is unknown when nothing can be read, including a broken pointer", () => {
    expect(buildId({ env: {}, cwd: root() })).toBe(UNKNOWN_BUILD);
    expect(buildId({ env: {}, cwd: root({ ".eve/dev-runtime/current.json": "{not json" }) })).toBe(UNKNOWN_BUILD);
  });
});
