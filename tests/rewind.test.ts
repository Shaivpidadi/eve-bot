import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Action } from "../agent/lib/actions";
import type { Job } from "../agent/lib/types";

/**
 * Rewinding a job: the record goes back to a step, the run holding it is
 * dropped, the job is queued to run again, what was sent stays listed as
 * done, and the job's own files come back as they were.
 */

const WORKSPACE = "default";

async function jobWithJournal() {
  const jobs = await import("../agent/lib/jobs");
  const bots = await import("../agent/lib/bots");
  const bot = await bots.hireBot({ workspaceId: WORKSPACE, hiredBy: "operator", name: "Atlas", role: "Generalist", persona: "Careful and brief." });
  const job = await jobs.assignJob({ workspaceId: WORKSPACE, botId: bot.id, requestedBy: "operator", title: "Two files", brief: "Write a then b." });
  expect((await jobs.claimJob(WORKSPACE, job.id, { token: "run_1", forMs: 60_000, status: "running", kind: "run" })).ok).toBe(true);
  expect((await jobs.bindRun(WORKSPACE, job.id, "run_1", "sess_A")).ok).toBe(true);
  for (const [kind, text, path] of [
    ["progress", "Started", null],
    ["file", "Wrote a", "/workspace/bots/Atlas/a.txt"],
    ["decision", "Write b next", null],
    ["file", "Wrote b", "/workspace/bots/Atlas/b.txt"],
  ] as const) {
    await jobs.appendJournal(WORKSPACE, job.id, "sess_A", { kind, text, ...(path ? { data: { path } } : {}) });
  }
  return { jobs, job, bot };
}

describe("rewindJob", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("BOT_STORE", "memory");
  });

  it("cuts the journal, drops the run, and queues the job", async () => {
    const { jobs, job } = await jobWithJournal();
    const rewound = await jobs.rewindJob(WORKSPACE, job.id, 2, "Ava", ["Sent an email to a@x"]);
    expect(rewound.ok).toBe(true);
    if (!rewound.ok) return;
    expect(rewound.sessions).toEqual(["sess_A"]);
    const after = (await jobs.getJob(WORKSPACE, job.id)) as Job;
    expect(after).toMatchObject({ status: "queued", lease: null, result: null });
    expect(after.journal?.map((line) => line.text)).toEqual(["Started", "Wrote a"]);
    expect(after.rewound).toMatchObject({ by: "Ava", index: 2, kept: ["Sent an email to a@x"] });
    expect(after.rewound?.undone.map((line) => line.text)).toEqual(["Write b next", "Wrote b"]);
    // The old run is nobody now; the job is due for a fresh one.
    expect(jobs.runCheckOf(after, "sess_A").ok).toBe(false);
    expect((await jobs.dueJobs(10)).map((due) => due.id)).toContain(job.id);
  });

  it("refuses a step that is not there, and a cancelled job", async () => {
    const { jobs, job } = await jobWithJournal();
    expect(await jobs.rewindJob(WORKSPACE, job.id, 9, "me")).toMatchObject({ ok: false });
    expect(await jobs.rewindJob(WORKSPACE, job.id, -1, "me")).toMatchObject({ ok: false });
    await jobs.cancelJob(WORKSPACE, job.id);
    expect(await jobs.rewindJob(WORKSPACE, job.id, 1, "me")).toMatchObject({ ok: false, reason: expect.stringContaining("cancelled") });
  });

  it("tells the next run where it was taken back to and what stays done", async () => {
    const { jobs, job, bot } = await jobWithJournal();
    await jobs.rewindJob(WORKSPACE, job.id, 2, "Ava", ["Sent an email to a@x (sent, 2026-10-13 10:00 UTC)"]);
    const { renderBrief } = await import("../agent/lib/brief");
    const brief = renderBrief(bot, (await jobs.getJob(WORKSPACE, job.id)) as Job, { token: "run_2" });
    expect(brief).toContain("## Rewound");
    expect(brief).toContain("took this job back to step 2");
    expect(brief).toContain("- Sent an email to a@x");
    expect(brief).toContain("2. [file] Wrote a");
    expect(brief).not.toContain("Wrote b");
  });
});

describe("rewind", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("BOT_STORE", "memory");
  });

  it("lists sent emails after the point as kept, restores the nearest saved files, and records it", async () => {
    const { keptActions } = await import("../agent/lib/rewind");
    const action = (over: Partial<Action>): Action => ({ actionId: "a", workspaceId: WORKSPACE, jobId: "job_1", kind: "email.send", target: ["a@x"], state: "succeeded", createdAt: "2026-10-13T10:05:00.000Z", ...over }) as Action;
    expect(
      keptActions(
        [
          action({ createdAt: "2026-10-13T09:00:00.000Z" }),
          action({ target: ["b@x"] }),
          action({ target: ["c@x"], state: "failed" }),
          action({ target: ["d@x"], jobId: "job_2" }),
          action({ target: ["e@x"], state: "delivery_unknown" }),
        ],
        "job_1",
        "2026-10-13T10:00:00.000Z",
      ),
    ).toEqual(["Sent an email to b@x (sent, 2026-10-13 10:05 UTC)", "Sent an email to e@x (possibly sent, 2026-10-13 10:05 UTC)"]);
  });

  it("restores from the generation at or before the step", async () => {
    const { jobs, job } = await jobWithJournal();
    const { takeGeneration } = await import("../agent/lib/generations");
    const restores: { paths: string[]; bytes: number[] | null }[] = [];
    const hands = {
      files: {
        archive: async () => new Uint8Array([7]),
        restore: async (paths: readonly string[], archive: Uint8Array | null) => {
          restores.push({ paths: [...paths], bytes: archive === null ? null : [...archive] });
        },
      },
    } as never;
    const current = (await jobs.getJob(WORKSPACE, job.id)) as Job;
    await takeGeneration(hands, { workspaceId: WORKSPACE, job: current, botName: "Atlas", index: 0, reason: "start" });
    const { rewind } = await import("../agent/lib/rewind");
    const done = await rewind({ workspaceId: WORKSPACE, jobId: job.id, index: 1, by: "Ava" }, async () => hands);
    expect(done.ok && done.outcome.files).toEqual({ restoredFrom: 0 });
    expect(restores[0]).toEqual({ paths: ["/workspace/bots/Atlas", "/workspace/bots/atlas"], bytes: [7] });
    const { recentActivity } = await import("../agent/lib/activity");
    const line = (await recentActivity(WORKSPACE, { jobId: job.id })).find((event) => event.kind === "job.rewound");
    expect(line?.text).toContain('Ava took "Two files" back to step 1; its files are as they were at step 0');
  });
});
