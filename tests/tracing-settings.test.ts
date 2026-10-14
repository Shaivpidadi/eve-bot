import { beforeEach, describe, expect, it, vi } from "vitest";

/** Agent Runs settings: on with content off until changed, saved for the deployment, and read without waiting by the trace hooks. */

describe("tracing settings", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("BOT_STORE", "memory");
  });

  it("defaults to runs on and content off", async () => {
    const tracing = await import("../agent/lib/tracing-settings");
    expect(tracing.tracingNow()).toMatchObject({ agentRuns: true, content: false });
    expect(await tracing.readTracingSettings()).toMatchObject({ agentRuns: true, content: false, updatedBy: null });
  });

  it("saves a change and serves it to the trace hooks at once", async () => {
    const tracing = await import("../agent/lib/tracing-settings");
    const saved = await tracing.writeTracingSettings({ content: true }, "Shaishav");
    expect(saved).toMatchObject({ agentRuns: true, content: true, updatedBy: "Shaishav" });
    expect(tracing.tracingNow()).toMatchObject({ content: true });
    await tracing.writeTracingSettings({ agentRuns: false }, "Shaishav");
    expect(tracing.tracingNow()).toMatchObject({ agentRuns: false, content: true });
  });

  it("picks up a change made elsewhere on the next background refresh", async () => {
    const store = await import("../agent/lib/store");
    const tracing = await import("../agent/lib/tracing-settings");
    await tracing.readTracingSettings();
    await store.writeDoc("settings/tracing.json", { agentRuns: false, content: true });
    // Fresh copy: no refresh yet.
    expect(tracing.tracingNow().agentRuns).toBe(true);
    // A minute on, the read starts in the background and lands shortly.
    tracing.tracingNow(Date.now() + 61_000);
    await vi.waitFor(() => expect(tracing.tracingNow()).toMatchObject({ agentRuns: false, content: true }));
  });
});
