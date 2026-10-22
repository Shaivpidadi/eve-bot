import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Claude Code and Codex on the owner's own plan, on a standalone server's team
 * computer: how a run is signed in, started and read, when the engine is
 * refused, and the MCP endpoint its CLI reaches eve-bot's tools through.
 */

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv("BOT_STORE", "memory");
  vi.stubEnv("BOT_COMPUTER_KEY", "k".repeat(40));
  vi.stubEnv("BOT_CONSOLE_TOKEN", "");
  vi.stubEnv("BOT_CONSOLE_TOKENS", "");
});
afterEach(() => vi.unstubAllEnvs());

describe("signing in", () => {
  it("passes a plan's token, an API key, or another address's key the way each CLI reads it", async () => {
    const { signIn } = await import("../agent/lib/engines/local");
    expect(signIn("claude-code-local", {})).toBeNull();
    expect(signIn("claude-code-local", { BOT_LOCAL_CLAUDE_TOKEN: "sk-ant-oat01-plan" })).toEqual({ env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-plan" }, files: {}, paid: false });
    expect(signIn("claude-code-local", { BOT_LOCAL_CLAUDE_TOKEN: "sk-ant-api03-key" })).toMatchObject({ env: { ANTHROPIC_API_KEY: "sk-ant-api03-key" }, paid: true });
    expect(signIn("claude-code-local", { BOT_LOCAL_CLAUDE_TOKEN: "gw-key", BOT_LOCAL_CLAUDE_BASE_URL: "https://ai-gateway.vercel.sh" })).toMatchObject({ env: { ANTHROPIC_BASE_URL: "https://ai-gateway.vercel.sh", ANTHROPIC_AUTH_TOKEN: "gw-key" } });
    expect(signIn("codex-local", { BOT_LOCAL_CODEX_AUTH: '{"tokens":{}}' })).toEqual({ env: {}, files: { ".codex/auth.json": '{"tokens":{}}' }, paid: false });
    expect(signIn("codex-local", { BOT_LOCAL_CODEX_API_KEY: "sk-openai" })).toMatchObject({ env: { BOT_CODEX_KEY: "sk-openai" }, paid: true });
  });

  it("reaches this server from inside the computer's container", async () => {
    const { toolsUrl } = await import("../agent/lib/engines/local");
    expect(toolsUrl("http://localhost:3000", {})).toBe("http://host.docker.internal:3000/bot/v1/engine/mcp");
    expect(toolsUrl("http://127.0.0.1:4274", {})).toBe("http://host.docker.internal:4274/bot/v1/engine/mcp");
    expect(toolsUrl("https://bot.example.com", {})).toBe("https://bot.example.com/bot/v1/engine/mcp");
    expect(toolsUrl("http://localhost:3000", { BOT_ENGINE_TOOLS_URL: "http://172.17.0.1:3000/bot/v1/engine/mcp/" })).toBe("http://172.17.0.1:3000/bot/v1/engine/mcp");
  });
});

describe("starting a run", () => {
  const plan = {
    runId: "local_abc",
    workingDirectory: "/workspace/bots/Cody",
    brief: "Do it.",
    instructions: "Be good.",
    toolsUrl: "http://host.docker.internal:3000/bot/v1/engine/mcp",
    secret: "the-run-secret-value",
    model: null,
    builtins: false,
    env: {},
  };

  it("runs Claude Code in print mode with only eve-bot's tools, its secret kept in the environment", async () => {
    const { launchCommand } = await import("../agent/lib/engines/local");
    const command = launchCommand({ ...plan, engine: "claude-code-local" });
    expect(command).toMatch(/^nohup setsid bash -c /);
    expect(command).toContain("/workspace/.engines/cli/bin/claude -p");
    expect(command).toContain("--output-format stream-json --verbose");
    expect(command).toContain("--strict-mcp-config");
    expect(command).toContain("mcp__bot__*");
    expect(command).toContain("Bearer ${BOT_RUN_SECRET}");
    expect(command).not.toContain("the-run-secret-value");
    expect(command).toContain("events.jsonl");
    // No shell or files unless the owner turned them on.
    expect(command).toContain("mcp__bot__*'");
    expect(command).toMatch(/--disallowedTools \S*Bash,Read/);
    expect(launchCommand({ ...plan, engine: "claude-code-local", builtins: true })).toContain("mcp__bot__*,Bash,Read");
  });

  it("runs Codex in exec mode against eve-bot's MCP server, with a key's provider when there is one", async () => {
    const { launchCommand } = await import("../agent/lib/engines/local");
    const command = launchCommand({ ...plan, engine: "codex-local" });
    expect(command).toContain("/workspace/.engines/cli/bin/codex exec --json --skip-git-repo-check");
    expect(command).toContain("--sandbox read-only");
    expect(command).toContain("bearer_token_env_var");
    expect(command).not.toContain("the-run-secret-value");
    expect(command).not.toContain("model_provider=bot");
    expect(launchCommand({ ...plan, engine: "codex-local", env: { BOT_CODEX_KEY: "k" } })).toContain("model_provider=bot");
  });
});

describe("reading a run", () => {
  it("hears Claude Code's words and how its turn ended, and only whole lines", async () => {
    const { parseLook, lookResult } = await import("../agent/lib/engines/local");
    const lines = [
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Reading the brief." }, { type: "tool_use", name: "mcp__bot__job_brief" }] } }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.012, modelUsage: { "claude-sonnet-4-5": {} } }),
    ];
    const body = `${lines.join("\n")}\n{"type":"assist`;
    const look = parseLook(`exit:0\nsize:999\n---\n${body}`, 100);
    expect(look.said).toEqual(["Reading the brief."]);
    expect(look.outcome).toEqual({ ok: true, error: null, usd: 0.012, model: "claude-sonnet-4-5" });
    // The half-written line waits for the next look.
    expect(look.cursor).toBe(100 + Buffer.byteLength(`${lines.join("\n")}\n`));
    expect(lookResult(look, "")).toEqual({ kind: "ended", ok: true });
    expect(lookResult(parseLook("exit:\nsize:0\n---\n", 0), "")).toEqual({ kind: "working" });
    expect(lookResult(parseLook("exit:1\nsize:0\n---\n", 0), "Error: Invalid API key")).toEqual({ kind: "ended", ok: false, error: "The CLI stopped (exit 1): Error: Invalid API key" });
  });

  it("hears Codex's agent messages and its turn's end or failure", async () => {
    const { parseLook } = await import("../agent/lib/engines/local");
    const ok = parseLook(`exit:0\n---\n${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Done." } })}\n${JSON.stringify({ type: "turn.completed", usage: {} })}\n`, 0);
    expect(ok.said).toEqual(["Done."]);
    expect(ok.outcome).toMatchObject({ ok: true });
    const failed = parseLook(`exit:1\n---\n${JSON.stringify({ type: "turn.failed", error: { message: "usage limit reached" } })}\n`, 0);
    expect(failed.outcome).toMatchObject({ ok: false, error: "usage limit reached" });
  });
});

describe("where a plan engine runs", () => {
  const standalone = { BOT_COMPUTER: "local", BOT_LOCAL_CLAUDE_TOKEN: "sk-ant-oat01-plan" };

  it("on a standalone server's own computer, for the owner, once signed in", async () => {
    const { engineRefusal, engineChoices } = await import("../agent/lib/engines");
    expect(engineRefusal("claude-code-local", { workspaceId: "default", env: standalone })).toBeNull();
    expect(engineRefusal("claude-code-local", { workspaceId: "default", env: { ...standalone, VERCEL: "1" } })).toMatch(/standalone/);
    expect(engineRefusal("claude-code-local", { workspaceId: "default", env: { ...standalone, BOT_COMPUTER: "vercel" } })).toMatch(/BOT_COMPUTER=local/);
    expect(engineRefusal("claude-code-local", { workspaceId: "tenant", env: standalone })).toMatch(/owner's workspace/);
    expect(engineRefusal("codex-local", { workspaceId: "default", env: standalone })).toMatch(/codex login --device-auth/);
    expect(engineChoices("default", standalone)).toEqual(["eve", "claude-code-local"]);
  });
});

describe("the MCP endpoint a run's CLI reaches", () => {
  type Route = { method: string; path: string; handler: (request: Request, args: unknown) => Promise<Response> };
  const call = async (secret: string, body: unknown) => {
    const ops = (await import("../agent/channels/ops")).default as unknown as { routes: Route[] };
    const route = ops.routes.find((candidate) => candidate.method === "POST" && candidate.path === "/bot/v1/engine/mcp")!;
    return route.handler(new Request("http://localhost/bot/v1/engine/mcp", { method: "POST", headers: { authorization: `Bearer ${secret}` }, body: JSON.stringify(body) }), { params: {} });
  };

  it("answers only a running run's secret, lists the tools, and fences their calls to the job's run", async () => {
    expect((await call("not-a-run-secret-at-all", { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(401);
    const { writeDoc } = await import("../agent/lib/store");
    const { runSecretHash, runSecretKey } = await import("../agent/lib/engines/local");
    const secret = "a-running-runs-secret-0123456789";
    await writeDoc(runSecretKey(runSecretHash(secret)), { workspaceId: "default", jobId: "job_none", runId: "local_x", engine: "claude-code-local", at: "" });
    const init = (await (await call(secret, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })).json()) as { result: { serverInfo: { name: string } } };
    expect(init.result.serverInfo.name).toBe("eve-bot");
    expect((await call(secret, { jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
    const listed = (await (await call(secret, { jsonrpc: "2.0", id: 2, method: "tools/list" })).json()) as { result: { tools: { name: string }[] } };
    expect(listed.result.tools.map((tool) => tool.name)).toEqual(["job_brief", "log_progress", "finish_job", "send_email", "connector_tools", "connector_read", "connector_change"]);
    // The job does not exist, so the tool itself refuses: the endpoint never decides that.
    const brief = (await (await call(secret, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "job_brief", arguments: {} } })).json()) as { result: { isError: boolean } };
    expect(brief.result.isError).toBe(true);
  });
});

describe("the address a run's CLI is given", () => {
  it("is the one the console reached, not eve's own port behind next dev's proxy", async () => {
    const { noteOrigin, publicOrigin } = await import("../agent/lib/self");
    await noteOrigin(new Request("http://localhost:56889/bot/v1/state", { headers: { host: "localhost:56889", "x-forwarded-host": "localhost:3401", "x-forwarded-proto": "http" } }));
    expect(await publicOrigin()).toBe("http://localhost:3401");
    vi.stubEnv("BOT_PUBLIC_URL", "https://bot.example.com/");
    vi.resetModules();
    expect(await (await import("../agent/lib/self")).publicOrigin()).toBe("https://bot.example.com");
  });
});
