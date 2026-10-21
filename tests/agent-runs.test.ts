import { describe, expect, it, vi } from "vitest";

const register = vi.fn();
const agentRuns = vi.fn(() => ({ register }));
vi.mock("durable-harness/instrumentation/otel", () => ({ agentRuns }));

/** Claude Code and Codex sessions in Vercel Agent Runs: once per process, and only where there is Vercel to send them to. */
describe("registerAgentRuns", () => {
  it("does nothing off Vercel, and registers once on it", async () => {
    const { registerAgentRuns } = await import("../src/lib/engines/agent-runs");
    registerAgentRuns({});
    expect(agentRuns).not.toHaveBeenCalled();
    registerAgentRuns({ VERCEL: "1" });
    registerAgentRuns({ VERCEL: "1" });
    expect(register).toHaveBeenCalledTimes(1);
    // Metadata only: no audience is passed, so sessions keep the default.
    expect(agentRuns).toHaveBeenCalledWith(expect.not.objectContaining({ audience: expect.anything() }));
  });
});
