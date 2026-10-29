import { spawnSync } from "node:child_process";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { computerRuntime } from "../agent/lib/computer/script";

import { batchResults, cliOutdated, textOf, type BrowserResult } from "../agent/subagents/teammate/lib/browser";
import { classifyTool, pickTool, readTools, toolPrint, toolReturned, type PageTool } from "../agent/subagents/teammate/lib/page-tools";
import { MAX_RECORDING_MS, nextStep, recordingOn } from "../agent/subagents/teammate/lib/recording";

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

describe("page tools", () => {
  const tool = (name: string, extra: Partial<PageTool> = {}): PageTool => ({ name, description: "", frame: "F1", origin: "https://a.example", inputSchema: {}, annotations: {}, ...extra });

  it("read the list agent-browser prints, dropping malformed entries", () => {
    expect(readTools({ tools: [{ name: "search", frameId: "F1", description: "Find", inputSchema: { type: "object" } }, { name: "" }, null, { frameId: "F2" }] })).toEqual([
      { name: "search", description: "Find", frame: "F1", origin: "", inputSchema: { type: "object" }, annotations: {} },
    ]);
    expect(readTools(null)).toEqual([]);
  });

  it("ask a person by the tool's name, a destructive mark, or a payment page, never trusting a read-only claim", () => {
    expect(classifyTool(tool("search_products"), "https://shop.example/products").verdict).toBe("safe");
    expect(classifyTool(tool("get-weather"), "https://a.example/").verdict).toBe("safe");
    expect(classifyTool(tool("addToCart"), "https://shop.example/").reasons).toEqual(['the page\'s tool is called "addToCart" ("add")']);
    expect(classifyTool(tool("send_message", { annotations: { readOnlyHint: true } }), "https://a.example/").verdict).toBe("consequential");
    expect(classifyTool(tool("lookup", { annotations: { destructiveHint: true } }), "https://a.example/").verdict).toBe("consequential");
    expect(classifyTool(tool("lookup"), "https://shop.example/checkout/step-2").verdict).toBe("consequential");
  });

  it("pick one tool, asking for the frame when a name is in two", () => {
    const tools = [tool("search"), tool("search", { frame: "F2" }), tool("open")];
    expect(pickTool(tools, "open")).toMatchObject({ tool: { name: "open" } });
    expect(pickTool(tools, "search")).toEqual({ problem: 'the page offers "search" in 2 frames; pass the frame of the one you mean' });
    expect(pickTool(tools, "search", "F2")).toMatchObject({ tool: { frame: "F2" } });
    expect(pickTool(tools, "nope")).toMatchObject({ problem: expect.stringMatching(/no tool named/) });
  });

  it("are approved for what they say: a changed description is another tool", () => {
    expect(toolPrint(tool("a", { description: "x" }))).not.toBe(toolPrint(tool("a", { description: "y" })));
    expect(toolPrint(tool("a"))).toBe(toolPrint(tool("a")));
  });

  it("hand back the result's text, shortened", () => {
    expect(toolReturned({ status: "completed", output: { content: [{ type: "text", text: "saved hi" }] } })).toEqual({ status: "completed", output: "saved hi" });
    expect(toolReturned({ status: "failed", output: "boom" })).toEqual({ status: "failed", output: "boom" });
    expect(toolReturned(null)).toEqual({ status: "unknown", output: "" });
    expect(toolReturned({ status: "completed", output: { content: [{ type: "text", text: "x".repeat(5000) }] } }).output).toHaveLength(4000);
  });
});

describe("recording a job's browser", () => {
  it("is off unless switched on", () => {
    expect(recordingOn({})).toBe(false);
    expect(recordingOn({ BOT_BROWSER_RECORDING: "off" })).toBe(false);
    expect(recordingOn({ BOT_BROWSER_RECORDING: "on" })).toBe(true);
    expect(recordingOn({ BOT_BROWSER_RECORDING: "1" })).toBe(true);
  });

  it("starts once, waits a minute between asks while ffmpeg installs, and stops after half an hour", () => {
    const now = 10 * 60 * 60_000;
    expect(nextStep(undefined, now)).toBe("check");
    expect(nextStep({ state: "waiting", checkedAt: now - 30_000 }, now)).toBe("nothing");
    expect(nextStep({ state: "waiting", checkedAt: now - 60_000 }, now)).toBe("check");
    expect(nextStep({ state: "on", startedAt: now - 29 * 60_000 }, now)).toBe("nothing");
    expect(nextStep({ state: "on", startedAt: now - MAX_RECORDING_MS - 1 }, now)).toBe("stop");
    expect(nextStep({ state: "stopped" }, now)).toBe("nothing");
  });

  it("installs ffmpeg on the computer only when asked, in a script bash accepts", () => {
    const script = computerRuntime().files.find((file) => file.path.endsWith("/bot-computer"))!.content;
    expect(script).toContain("recorder) cmd_recorder ;;");
    // A finished run's session, and the recorder it started, can be ended.
    expect(script).toContain('end-run) cmd_end_run "$2" ;;');
    expect(script).toContain("--enable-features=WebMCPTesting,DevToolsWebMCPSupport");
    // Not in the packages every computer installs: it is large, and most teams never record.
    expect(/^PACKAGES="([^"]+)"/m.exec(script)?.[1]).not.toContain("ffmpeg");
    const checked = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
    expect(checked.stderr).toBe("");
    expect(checked.status).toBe(0);
  });
});

describe("keeping a job's recording", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("BOT_STORE", "memory");
  });

  it("stops a recording whose file is still empty, then keeps what it wrote", async () => {
    vi.doMock("../agent/lib/jobs", async (original) => ({ ...(await original<object>()), attachArtifact: vi.fn(async () => ({ ok: true })) }));
    vi.doMock("../agent/subagents/teammate/lib/journal", () => ({ journal: vi.fn(async () => undefined) }));
    const { keepJobRecording } = await import("../agent/subagents/teammate/lib/recording");
    // ffmpeg writes nothing until it has frames: a short run's file is empty until the recording stops.
    let video = new Uint8Array(0);
    const sandbox = {
      run: async ({ command }: { command: string }) => ({ exitCode: command.startsWith("test -s") && video.byteLength === 0 ? 1 : 0, stdout: "", stderr: "" }),
      readBinaryFile: async () => video,
    };
    const ctx = { getSandbox: async () => sandbox, session: { id: "s1", auth: { initiator: { principalId: "owner", attributes: { workspaceId: "w1" } } } } };
    const stop = vi.fn(async () => {
      video = new Uint8Array([26, 69, 223, 163]);
    });
    const kept = await keepJobRecording(ctx as never, "job_1", "/workspace/sessions/s1", stop);
    expect(stop).toHaveBeenCalledOnce();
    expect(kept).toMatchObject({ name: "Browser recording.webm", mediaType: "video/webm" });
    vi.doUnmock("../agent/lib/jobs");
    vi.doUnmock("../agent/subagents/teammate/lib/journal");
  });
});

describe("a large artifact", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("BOT_STORE", "memory");
  });

  it("keeps its bytes apart from its record, and reads back the same", async () => {
    const artifacts = await import("../agent/lib/artifacts");
    const bytes = new Uint8Array(3 * 1024 * 1024).fill(7);
    const meta = await artifacts.saveLargeArtifact({ workspaceId: "ws", name: "Browser recording.webm", mediaType: "video/webm", bytes });
    const stored = await artifacts.readArtifact(meta.key);
    expect(stored?.base64).toBeUndefined();
    expect((await artifacts.artifactBytes(stored!))?.byteLength).toBe(bytes.byteLength);
    // A small one reads the same way.
    const small = await artifacts.saveArtifact({ workspaceId: "ws", name: "a.txt", mediaType: "text/plain", bytes: new TextEncoder().encode("hi") });
    expect(new TextDecoder().decode((await artifacts.artifactBytes((await artifacts.readArtifact(small.key))!))!)).toBe("hi");
  });
});
