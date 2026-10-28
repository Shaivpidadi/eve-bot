import { describe, expect, it } from "vitest";

import { batchResults, cliOutdated, textOf, type BrowserResult } from "../agent/subagents/teammate/lib/browser";

/** agent-browser 0.40 on the team computer (docs/plan/agent-browser.md). */

describe("the computer's agent-browser version", () => {
  it("is moved up only when it is older than the one this app speaks", () => {
    expect(cliOutdated("agent-browser 0.39.1", "0.40.0")).toBe(true);
    expect(cliOutdated("agent-browser 0.40.0\n", "0.40.0")).toBe(false);
    expect(cliOutdated("agent-browser 0.41.2", "0.40.0")).toBe(false);
    expect(cliOutdated("agent-browser 1.0.0", "0.40.0")).toBe(false);
    expect(cliOutdated("agent-browser 0.9.9", "0.40.0")).toBe(true);
    // A missing CLI is installed elsewhere, never reinstalled in a loop.
    expect(cliOutdated("command not found", "0.40.0")).toBe(false);
  });
});

/** What `agent-browser --json batch …` printed for a page read, as checked by hand against 0.40. */
const batch = (steps: unknown[]): BrowserResult => ({ ok: true, output: "", data: steps });

describe("a batch's answer", () => {
  it("gives each command its own result, read like a lone command's", () => {
    const [wait, snapshot, url] = batchResults(
      batch([
        { command: ["wait", "--load", "domcontentloaded"], error: null, result: { state: "domcontentloaded" }, success: true },
        { command: ["snapshot", "-c"], error: null, result: { snapshot: '- button "Go" [ref=e2]', refs: {} }, success: true },
        { command: ["get", "url"], error: null, result: { url: "https://example.com/" }, success: true },
      ]),
      3,
    );
    expect(wait!.ok).toBe(true);
    expect(textOf(snapshot!, "snapshot")).toBe('- button "Go" [ref=e2]');
    expect(textOf(url!, "url")).toBe("https://example.com/");
  });

  it("keeps the others when one command failed", () => {
    // The CLI exits 1 then; `browser` keeps the printed array as the failure's data.
    const failed: BrowserResult = {
      ok: false,
      output: "",
      error: "agent-browser exited 1",
      data: [
        { command: ["wait", "--load", "domcontentloaded"], error: "Timeout waiting for load", result: null, success: false },
        { command: ["get", "url"], error: null, result: { url: "https://example.com/" }, success: true },
      ],
    };
    const [wait, url] = batchResults(failed, 2);
    expect(wait).toMatchObject({ ok: false, error: "Timeout waiting for load" });
    expect(textOf(url!, "url")).toBe("https://example.com/");
  });

  it("fails every step when the batch never ran, or a step is missing", () => {
    const never: BrowserResult = { ok: false, output: "", data: null, error: "Call job_brief first" };
    expect(batchResults(never, 2).map((step) => step.error)).toEqual(["Call job_brief first", "Call job_brief first"]);
    const short = batchResults(batch([{ command: ["wait", "1"], error: null, result: {}, success: true }]), 2);
    expect(short[1]).toMatchObject({ ok: false });
    expect(batchResults({ ok: true, output: "plain text", data: null }, 1)[0]).toMatchObject({ ok: false });
  });
});
