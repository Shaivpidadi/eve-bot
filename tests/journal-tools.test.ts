import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Job } from "../agent/lib/types";

/**
 * The teammate's tools leave a diary on the job: what it logged, which pages
 * it opened (once per visit), which files it wrote where the team keeps work,
 * and what failed. Nothing here reaches a computer; eve's own tools are
 * stubbed, and the store is the in-memory one.
 */

vi.mock("../agent/lib/computer-backup", () => ({
  ensureComputerRestored: vi.fn(async () => undefined),
  checkpointComputer: vi.fn(async () => undefined),
}));

const shell = vi.hoisted(() => ({ exitCode: 0 }));
vi.mock("../agent/lib/computer/shell", () => ({
  isolatedBash: {
    description: "bash",
    inputSchema: { parse: (value: unknown) => value },
    execute: async () => ({ status: "completed", exitCode: shell.exitCode, stdout: "", stderr: shell.exitCode === 0 ? "" : "boom", truncated: false }),
  },
  isolatedWriteFile: {
    description: "write",
    inputSchema: { parse: (value: unknown) => value },
    execute: async (input: { filePath: string }) => ({ existed: false, path: input.filePath }),
  },
}));

const WORKSPACE = "default";

const ctxFor = (sessionId: string) =>
  ({
    session: {
      id: sessionId,
      auth: {
        current: { principalId: "runtime", principalType: "runtime", authenticator: "test", attributes: { workspaceId: WORKSPACE, room: "desk" } },
        initiator: null,
      },
      turn: { id: "t", sequence: 1 },
    },
    abortSignal: new AbortController().signal,
  }) as never;

type Exec = { execute: (input: unknown, ctx: never) => Promise<unknown> };
const tool = async (name: string) => (await import(`../agent/subagents/teammate/tools/${name}.ts`)).default as unknown as Exec;

/** A job claimed by run `run_1`, bound to session `sess_A` with a screen. */
async function running() {
  const jobs = await import("../agent/lib/jobs");
  const { bindSession } = await import("../agent/lib/computer/screens");
  const job = await jobs.assignJob({ workspaceId: WORKSPACE, botId: "bot_1", requestedBy: "operator", title: "Diary", brief: "Keep one." });
  expect((await jobs.claimJob(WORKSPACE, job.id, { token: "run_1", forMs: 60_000, status: "running", kind: "run" })).ok).toBe(true);
  expect((await jobs.bindRun(WORKSPACE, job.id, "run_1", "sess_A")).ok).toBe(true);
  await bindSession({ sessionId: "sess_A", workspaceId: WORKSPACE, botId: "bot_1", jobId: job.id, n: 1 });
  const read = async () => (await jobs.getJob(WORKSPACE, job.id)) as Job;
  return { job, read };
}

describe("the teammate's journal", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("BOT_STORE", "memory");
    shell.exitCode = 0;
  });

  it("keeps progress notes with their detail", async () => {
    const { job, read } = await running();
    const logProgress = await tool("log_progress");
    await logProgress.execute({ jobId: job.id, note: "Read the inbox: 3 new", detail: { count: 3 } }, ctxFor("sess_A"));
    expect((await read()).journal).toMatchObject([{ kind: "progress", runToken: "run_1", text: "Read the inbox: 3 new", data: { count: 3 } }]);
  });

  it("records a page once per visit, not per action", async () => {
    const { read } = await running();
    const { journalPage, forgetPage } = await import("../agent/subagents/teammate/lib/journal");
    const ctx = ctxFor("sess_A");
    await journalPage(ctx, "https://mail.example.com/inbox?x=1");
    await journalPage(ctx, "https://mail.example.com/inbox?x=1");
    await journalPage(ctx, "about:blank");
    await journalPage(ctx, "https://mail.example.com/inbox/42");
    expect((await read()).journal?.map((line) => line.text)).toEqual(["Opened mail.example.com/inbox", "Opened mail.example.com/inbox/42"]);
    // After a handover the tab may be anywhere: the same address is news again.
    forgetPage(ctx);
    await journalPage(ctx, "https://mail.example.com/inbox/42");
    expect((await read()).journal).toHaveLength(2); // same run, same line: not written twice
  });

  it("notes a file written where the team keeps work, and skips scratch", async () => {
    const { read } = await running();
    const writeFile = await tool("write_file");
    await writeFile.execute({ filePath: "/workspace/bots/atlas/report.md", content: "hello" }, ctxFor("sess_A"));
    await writeFile.execute({ filePath: "/workspace/sessions/run-1/tmp.txt", content: "scratch" }, ctxFor("sess_A"));
    expect((await read()).journal).toMatchObject([{ kind: "file", text: "Wrote /workspace/bots/atlas/report.md", data: { path: "/workspace/bots/atlas/report.md", bytes: 5 } }]);
  });

  it("notes a failed command, and nothing for one that worked", async () => {
    const { read } = await running();
    const bash = await tool("bash");
    await bash.execute({ command: "ls /workspace" }, ctxFor("sess_A"));
    shell.exitCode = 2;
    await bash.execute({ command: "grep   needle   haystack.txt" }, ctxFor("sess_A"));
    expect((await read()).journal).toMatchObject([{ kind: "error", text: "Command exited 2: grep needle haystack.txt", data: { tool: "bash", exitCode: 2 } }]);
  });

  it("writes nothing for a session that is not a job's run", async () => {
    await running();
    const { journal } = await import("../agent/subagents/teammate/lib/journal");
    const jobs = await import("../agent/lib/jobs");
    await journal(ctxFor("sess_B"), { kind: "progress", text: "not mine" });
    const all = await jobs.listJobs(WORKSPACE);
    expect(all.every((job) => (job.journal ?? []).length === 0)).toBe(true);
  });
});

describe("decisions", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("BOT_STORE", "memory");
  });

  it("are journaled as decisions and read first by the next run", async () => {
    const { job, read } = await running();
    const logProgress = await tool("log_progress");
    await logProgress.execute({ jobId: job.id, note: "Read the inbox" }, ctxFor("sess_A"));
    await logProgress.execute({ jobId: job.id, note: "Use the CSV export, the list view paginates at 50", kind: "decision" }, ctxFor("sess_A"));
    const journal = (await read()).journal ?? [];
    expect(journal.map((line) => line.kind)).toEqual(["progress", "decision"]);
    const { renderJournal } = await import("../agent/lib/journal");
    const text = renderJournal(journal);
    expect(text.indexOf("Decisions so far")).toBeLessThan(text.indexOf("Steps:"));
  });

  it("are put to Jev at the close, only when there are some", async () => {
    const { completionQuestions } = await import("../agent/lib/jev-watch");
    expect(Object.keys(completionQuestions(["A list"]))).toEqual(["overall", "criterion0"]);
    const withDecisions = completionQuestions(["A list"], ["Use the CSV export"]);
    expect(Object.keys(withDecisions)).toEqual(["overall", "decisions", "criterion0"]);
    expect(withDecisions.decisions?.instructions).toContain('"Use the CSV export"');
  });
});
