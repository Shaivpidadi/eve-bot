import { beforeEach, describe, expect, it, vi } from "vitest";

/** The console and the runtime charge reach the computer by the name its machine record holds. */
describe("machineName", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("BOT_STORE", "memory");
  });

  it("is the recorded Vercel sandbox or Docker container, else the computer's own name", async () => {
    const machine = await import("../agent/lib/machine");
    expect(await machine.machineName()).toBe("bot-computer");
    await machine.writeMachineRecord({ provider: "vercel", state: { sandboxName: "eve-sbx-vercel-abc", version: 1 }, at: "2026-10-16T10:00:00.000Z" });
    expect(await machine.machineName()).toBe("eve-sbx-vercel-abc");
    await machine.writeMachineRecord({ provider: "docker", state: { containerName: "eve-sbx-123", version: 2 }, at: "2026-10-16T10:00:00.000Z" });
    expect(await machine.machineName()).toBe("eve-sbx-123");
  });
});
