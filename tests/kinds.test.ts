import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The app adapts to the computer through its kind's capabilities: a browser
 * tool on a machine without a browser refuses in plain words, the brief says
 * what the Bot has, and a backup restores only onto the kind it came from.
 */
describe("computer kinds", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it("follows the configuration", async () => {
    vi.stubEnv("BOT_COMPUTER", "");
    expect((await import("../agent/lib/hands/kinds")).currentKind().name).toBe("vercel-linux");
    vi.resetModules();
    vi.stubEnv("BOT_COMPUTER", "local");
    expect((await import("../agent/lib/hands/kinds")).currentKind().name).toBe("docker-linux");
    vi.resetModules();
    vi.stubEnv("BOT_COMPUTER_LOCAL", "microsandbox");
    expect((await import("../agent/lib/hands/kinds")).currentKind()).toMatchObject({ name: "microsandbox-linux", label: "a VM on this machine" });
  });

  it("refuses what a kind cannot do, and says nothing for what it can", async () => {
    const { lacking, KINDS } = await import("../agent/lib/hands/kinds");
    expect(lacking(KINDS["docker-linux"], "browser")).toBeNull();
    const shellOnly = { name: "docker-linux" as const, label: "a Mac over SSH", capabilities: { screen: false, browser: false, handover: false, shell: true } };
    expect(lacking(shellOnly, "browser")).toBe("The team's computer (a Mac over SSH) has no web browser. Do this another way, or tell the operator it needs a computer with a web browser.");
    expect(lacking(shellOnly, "shell")).toBeNull();
  });

  it("puts one line in the brief", async () => {
    const { describeKind, KINDS } = await import("../agent/lib/hands/kinds");
    expect(describeKind(KINDS["vercel-linux"])).toBe("computer: Vercel Sandbox (screen, browser, handover, shell)");
  });

  it("restores a backup only onto its own kind", async () => {
    const { restoresOnto } = await import("../agent/lib/computer-backup");
    expect(restoresOnto({ kind: "docker-linux" }, "docker-linux")).toBe(true);
    expect(restoresOnto({ kind: "vercel-linux" }, "docker-linux")).toBe(false);
    expect(restoresOnto({}, "docker-linux")).toBe(true);
  });
});
