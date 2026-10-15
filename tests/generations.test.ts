import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Generation } from "../agent/lib/generations";
import type { Job } from "../agent/lib/types";

/** A job's rewind points: what they cover, which are kept, and which one a rewind restores. */

const gen = (index: number, over: Partial<Generation> = {}): Generation => ({ index, at: `2026-10-13T10:00:${String(index).padStart(2, "0")}.000Z`, reason: "decision", paths: [], key: `k${index}`, bytes: 1, ...over });

describe("generations", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("BOT_STORE", "memory");
  });

  it("cover the Bot's folder and the files the journal lists elsewhere", async () => {
    const { scopeFor } = await import("../agent/lib/generations");
    const job = {
      journal: [
        { at: "a", runToken: "r", kind: "file", text: "x", data: { path: "/workspace/shared/report.md" } },
        { at: "b", runToken: "r", kind: "file", text: "y", data: { path: "/workspace/bots/Atlas/notes.md" } },
        { at: "c", runToken: "r", kind: "file", text: "z", data: { path: "/etc/passwd" } },
      ],
    } as unknown as Job;
    expect(scopeFor(job, "Atlas")).toEqual(["/workspace/bots/Atlas", "/workspace/bots/atlas", "/workspace/shared/report.md"]);
    expect(scopeFor({} as Job, "atlas")).toEqual(["/workspace/bots/atlas"]);
  });

  it("rewind to the latest point at or before the step chosen", async () => {
    const { generationFor } = await import("../agent/lib/generations");
    const all = [gen(0), gen(3), gen(7)];
    expect(generationFor(all, 5)?.index).toBe(3);
    expect(generationFor(all, 7)?.index).toBe(7);
    expect(generationFor(all, 0)?.index).toBe(0);
    expect(generationFor([gen(2)], 1)).toBeNull();
  });

  it("keep the first and the latest", async () => {
    const { retained } = await import("../agent/lib/generations");
    const all = Array.from({ length: 14 }, (_, n) => gen(n));
    const { keep, drop } = retained(all, 10);
    expect(keep.map((g) => g.index)).toEqual([0, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    expect(drop.map((g) => g.index)).toEqual([1, 2, 3, 4]);
  });

  it("are taken once per step, stored, pruned, and restored over everything the job owns", async () => {
    const { takeGeneration, listGenerations, restoreGeneration } = await import("../agent/lib/generations");
    const { readBytes } = await import("../agent/lib/store/index");
    const archived: string[][] = [];
    const restored: { paths: string[]; bytes: number[] | null }[] = [];
    const hands = {
      files: {
        archive: async (paths: readonly string[]) => {
          archived.push([...paths]);
          return new Uint8Array([archived.length]);
        },
        restore: async (paths: readonly string[], archive: Uint8Array | null) => {
          restored.push({ paths: [...paths], bytes: archive === null ? null : [...archive] });
        },
      },
    } as never;
    const job = { id: "job_1", journal: [] } as unknown as Job;
    const first = await takeGeneration(hands, { workspaceId: "default", job, botName: "Atlas", index: 0, reason: "start" });
    expect(first).toMatchObject({ index: 0, bytes: 1, paths: ["/workspace/bots/Atlas", "/workspace/bots/atlas"] });
    expect(await takeGeneration(hands, { workspaceId: "default", job, botName: "Atlas", index: 0, reason: "again" })).toBeNull();
    for (let index = 1; index <= 12; index += 1) await takeGeneration(hands, { workspaceId: "default", job, botName: "Atlas", index, reason: "decision" });
    const kept = await listGenerations("default", "job_1");
    expect(kept.map((g) => g.index)).toEqual([0, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(await readBytes(first!.key!)).toEqual(new Uint8Array([1]));

    await restoreGeneration(hands, kept[0]!, ["/workspace/bots/Atlas", "/workspace/shared/new.md"]);
    expect(restored[0]).toEqual({ paths: ["/workspace/bots/Atlas", "/workspace/bots/atlas", "/workspace/shared/new.md"], bytes: [1] });
  });
});
