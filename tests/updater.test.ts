import { describe, expect, it } from "vitest";

import { latestRun, startUpdate, UpdateError } from "../agent/lib/updater";

/**
 * "Update now" from the console: the copy's workflows are brought up to the
 * release in one commit (its sync workflow's own token may not change them),
 * then its sync runs; a token GitHub refuses says what it lacks.
 */

const repo = { owner: "ann", slug: "my-bot" };
const b64 = (text: string) => Buffer.from(text).toString("base64");

function fakeGitHub(options: { copyWorkflow: string | null; refuse?: number }) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    const path = url.replace("https://api.github.com", "");
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    const reply = (status: number, value?: unknown) => new Response(value === undefined ? null : JSON.stringify(value), { status });
    if (options.refuse !== undefined && path.startsWith("/repos/ann/")) return reply(options.refuse, { message: "nope" });
    if (path === "/repos/ann/my-bot") return reply(200, { default_branch: "main" });
    if (path === "/repos/Shaivpidadi/eve-bot/git/ref/tags/v0.6.0") return reply(200, { object: { sha: "tag" } });
    if (path.startsWith("/repos/Shaivpidadi/eve-bot/contents/.github/workflows?")) return reply(200, [{ path: ".github/workflows/sync-upstream.yml", type: "file" }]);
    if (path.startsWith("/repos/Shaivpidadi/eve-bot/contents/.github/workflows/sync-upstream.yml")) return reply(200, { content: b64("new workflow") });
    if (path.startsWith("/repos/ann/my-bot/contents/.github/workflows/sync-upstream.yml"))
      return options.copyWorkflow === null ? reply(404, { message: "Not Found" }) : reply(200, { content: b64(options.copyWorkflow) });
    if (path === "/repos/ann/my-bot/git/ref/heads/main") return reply(200, { object: { sha: "head" } });
    if (path === "/repos/ann/my-bot/git/commits/head") return reply(200, { tree: { sha: "tree0" } });
    if (path === "/repos/ann/my-bot/git/trees") return reply(201, { sha: "tree1" });
    if (path === "/repos/ann/my-bot/git/commits") return reply(201, { sha: "commit1" });
    if (path === "/repos/ann/my-bot/git/refs/heads/main") return reply(200, { object: { sha: "commit1" } });
    if (path === "/repos/ann/my-bot/actions/workflows/sync-upstream.yml/dispatches") return reply(204);
    if (path.startsWith("/repos/ann/my-bot/actions/workflows/sync-upstream.yml/runs"))
      return reply(200, { workflow_runs: [{ status: "completed", conclusion: "success", html_url: "https://github.com/run", created_at: "2026-10-19T00:00:00Z" }] });
    return reply(404, { message: `unexpected ${method} ${path}` });
  }) as typeof fetch;
  return { calls, fetcher };
}

describe("startUpdate", () => {
  it("brings the copy's workflows up to the release in one commit, then runs its sync for that release", async () => {
    const github = fakeGitHub({ copyWorkflow: "old workflow" });
    const started = await startUpdate("token", repo, "0.6.0", github.fetcher);
    expect(started).toMatchObject({ tag: "v0.6.0", workflowsUpdated: [".github/workflows/sync-upstream.yml"] });
    const tree = github.calls.find((call) => call.path === "/repos/ann/my-bot/git/trees");
    expect(tree?.body).toEqual({ base_tree: "tree0", tree: [{ path: ".github/workflows/sync-upstream.yml", mode: "100644", type: "blob", content: "new workflow" }] });
    expect(github.calls.filter((call) => call.path === "/repos/ann/my-bot/git/commits" && call.method === "POST")).toHaveLength(1);
    const dispatch = github.calls.find((call) => call.path.endsWith("/dispatches"));
    expect(dispatch?.body).toEqual({ ref: "main", inputs: { target: "v0.6.0" } });
    // The original's files are read at the release, not at main.
    expect(github.calls.some((call) => call.path.includes("contents/.github/workflows?ref=v0.6.0"))).toBe(true);
  });

  it("makes no commit when the copy's workflows already match", async () => {
    const github = fakeGitHub({ copyWorkflow: "new workflow" });
    expect(await startUpdate("token", repo, "0.6.0", github.fetcher)).toMatchObject({ workflowsUpdated: [] });
    expect(github.calls.some((call) => call.path.endsWith("/git/trees"))).toBe(false);
    expect(github.calls.some((call) => call.path.endsWith("/dispatches"))).toBe(true);
  });

  it("says what a refused token lacks", async () => {
    await expect(startUpdate("token", repo, "0.6.0", fakeGitHub({ copyWorkflow: null, refuse: 403 }).fetcher)).rejects.toThrow(/Actions, Contents and Workflows/);
    const expired = await startUpdate("token", repo, "0.6.0", fakeGitHub({ copyWorkflow: null, refuse: 401 }).fetcher).catch((error: unknown) => error);
    expect(expired).toBeInstanceOf(UpdateError);
    expect((expired as UpdateError).message).toMatch(/expired/);
  });
});

describe("latestRun", () => {
  it("reports the copy's latest sync run", async () => {
    expect(await latestRun("token", repo, fakeGitHub({ copyWorkflow: null }).fetcher)).toEqual({
      status: "completed",
      conclusion: "success",
      url: "https://github.com/run",
      at: "2026-10-19T00:00:00Z",
    });
  });
});
