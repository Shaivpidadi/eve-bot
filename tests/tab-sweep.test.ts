import { beforeEach, describe, expect, it, vi } from "vitest";

/** A run's tab closes once its job is over, and only tabs runs recorded are ever closed. */
describe("closeFinishedTabs", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("BOT_STORE", "memory");
  });

  it("closes the tabs of finished jobs, keeps open ones, and forgets only what closed", async () => {
    const { writeDoc } = await import("../agent/lib/store");
    const screens = await import("../agent/lib/computer/screens");
    const { closeFinishedTabs } = await import("../agent/lib/computer/tab-sweep");
    const job = (id: string, status: string) => writeDoc(`jobs/ws/${id}.json`, { id, workspaceId: "ws", status });
    await job("job_done", "done");
    await job("job_open", "blocked");
    await job("job_cancelled", "cancelled");
    await job("job_stuck", "failed");
    const tab = (jobId: string) => ({ n: 1, sessionId: `s_${jobId}`, jobId, at: "2026-10-15T10:00:00.000Z" });
    await screens.noteRunTab("ws", "t_done", tab("job_done"));
    await screens.noteRunTab("ws", "t_open", tab("job_open"));
    await screens.noteRunTab("ws", "t_cancelled", tab("job_cancelled"));
    await screens.noteRunTab("ws", "t_kept", tab("job_done"));
    await screens.noteRunTab("ws", "t_stuck", tab("job_stuck"));

    const close = vi.fn(async (_n: number, targetId: string) => ({ ok: targetId !== "t_stuck" }));
    const closed = await closeFinishedTabs("ws", { browser: { close } } as never, "t_kept");

    expect(closed).toBe(2);
    expect(close.mock.calls.map(([, targetId]) => targetId).sort()).toEqual(["t_cancelled", "t_done", "t_stuck"]);
    expect(Object.keys(await screens.readRunTabs("ws")).sort()).toEqual(["t_kept", "t_open", "t_stuck"]);
  });
});
