import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fileKv } from "../agent/lib/store/fs";
import { KvConflictError, isConflict } from "../agent/lib/store/kv";

/** The disk store a standalone server keeps everything in. */
describe("fileKv", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "bot-store-"));
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it("reads back what it wrote, with a version that follows the content", async () => {
    const kv = fileKv(root);
    expect(await kv.get("jobs/a")).toBeNull();
    const version = await kv.put("jobs/a", '{"n":1}');
    expect(await kv.get("jobs/a")).toEqual({ value: '{"n":1}', version });
    const again = await kv.put("jobs/a", '{"n":2}');
    expect(again).not.toBe(version);
    expect((await kv.get("jobs/a"))?.version).toBe(again);
  });

  it("is a compare-and-set: a stale version or an unexpected existing key is a conflict", async () => {
    const kv = fileKv(root);
    const version = await kv.put("jobs/a", "one");
    await expect(kv.put("jobs/a", "two", { expectedVersion: null })).rejects.toBeInstanceOf(KvConflictError);
    await expect(kv.put("jobs/a", "two", { expectedVersion: "not-it" })).rejects.toBeInstanceOf(KvConflictError);
    await expect(kv.put("jobs/a", "two", { expectedVersion: version })).resolves.toBeTypeOf("string");
    await expect(kv.put("jobs/new", "x", { expectedVersion: null })).resolves.toBeTypeOf("string");
    expect((await kv.get("jobs/a"))?.value).toBe("two");
  });

  it("lets exactly one of several simultaneous conditional writers win", async () => {
    // Three saves in one model step all read the same version; only the first may land.
    const kv = fileKv(root);
    const base = await kv.put("memory/doc", "0: name");
    const results = await Promise.allSettled(
      ["a", "b", "c"].map((who) => kv.put("memory/doc", `0: name\n1: ${who}`, { expectedVersion: base })),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected" && result.reason instanceof KvConflictError)).toHaveLength(2);
    // Unconditional writes still queue rather than interleave, so the last one is what is read back.
    await Promise.all(["x", "y", "z"].map((who) => kv.put("memory/other", who)));
    expect((await kv.get("memory/other"))?.value).toBe("z");
  });

  it("lists by prefix and deletes", async () => {
    const kv = fileKv(root);
    await kv.put("jobs/default/j1", "a");
    await kv.put("jobs/default/j2", "b");
    await kv.put("bots/default/b1", "c");
    expect((await kv.list("jobs/default/")).sort()).toEqual(["jobs/default/j1", "jobs/default/j2"]);
    expect(await kv.list("nothing/")).toEqual([]);
    await kv.delete("jobs/default/j1");
    await kv.delete("jobs/default/missing");
    expect(await kv.list("jobs/default/")).toEqual(["jobs/default/j2"]);
  });

  it("keeps keys with awkward characters apart from paths", async () => {
    const kv = fileKv(root);
    await kv.put("memory/documents/mem%2Fscope key.md", "doc");
    expect((await kv.get("memory/documents/mem%2Fscope key.md"))?.value).toBe("doc");
    expect(await kv.list("memory/documents/")).toEqual(["memory/documents/mem%2Fscope key.md"]);
  });

  it("stores binary objects without versions", async () => {
    const kv = fileKv(root);
    expect(await kv.getBytes("computer/archive.tgz")).toBeNull();
    await kv.putBytes("computer/archive.tgz", new Uint8Array([1, 2, 3, 250]));
    expect(Array.from((await kv.getBytes("computer/archive.tgz")) ?? [])).toEqual([1, 2, 3, 250]);
  });
});

describe("isConflict", () => {
  it("recognises the local error and Blob's precondition failures", () => {
    expect(isConflict(new KvConflictError("k"))).toBe(true);
    expect(isConflict(Object.assign(new Error("x"), { name: "BlobPreconditionFailedError" }))).toBe(true);
    expect(isConflict(new Error("x"))).toBe(false);
    expect(isConflict(null)).toBe(false);
  });
});

/** Read-modify-write through the store the process selected. */
describe("updateDoc", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("BOT_STORE", "memory");
  });

  it("serialises overlapping updates to one key so neither is lost", async () => {
    const { updateDoc, readDoc } = await import("../agent/lib/store/index");
    const key = `test/counter/${Date.now()}`;
    await Promise.all(
      Array.from({ length: 12 }, () =>
        updateDoc<{ n: number }>(key, (current) => ({ n: (current?.n ?? 0) + 1 })),
      ),
    );
    expect((await readDoc<{ n: number }>(key))?.value).toEqual({ n: 12 });
  });

  it("lets a mutation abandon the write by returning null", async () => {
    const { updateDoc, readDoc, writeDoc } = await import("../agent/lib/store/index");
    const key = `test/claim/${Date.now()}`;
    await writeDoc(key, { owner: "a" });
    const result = await updateDoc<{ owner: string }>(key, (current) => (current?.owner === "a" ? null : { owner: "b" }));
    expect(result).toBeNull();
    expect((await readDoc<{ owner: string }>(key))?.value).toEqual({ owner: "a" });
  });

  it("picks the disk store off Vercel, whatever NODE_ENV says", async () => {
    vi.stubEnv("BOT_STORE", "");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
    vi.stubEnv("BLOB_STORE_ID", "");
    vi.stubEnv("BOT_DATA_DIR", "/tmp/bot-store-selection-test");
    vi.stubEnv("NODE_ENV", "production");
    const { store } = await import("../agent/lib/store/index");
    expect(store().name).toBe("fs(/tmp/bot-store-selection-test)");
  });
});
