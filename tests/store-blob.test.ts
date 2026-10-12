import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeBlobService, useFakeBlobEnv } from "./blob-fake";

/**
 * The Vercel Blob backend, end to end through the real @vercel/blob SDK against
 * a local fake of the Blob service (`tests/blob-fake.ts`). These pin the
 * driver's own semantics; `store-blob-invariants.test.ts` runs the M1
 * invariants and their callers on it, with faults.
 */

const blob = new FakeBlobService();

beforeAll(() => blob.start());
afterAll(() => blob.stop());

beforeEach(() => {
  blob.reset();
  vi.resetModules();
  useFakeBlobEnv();
});

const load = async () => (await import("../agent/lib/store/blob")).blobKv("t");

describe("blobKv on the Blob service", () => {
  it("is the backend store() picks when forced, and round-trips a document", async () => {
    const { store, readDoc, writeDoc } = await import("../agent/lib/store/index");
    expect(store().name).toBe("vercel-blob");
    const version = await writeDoc("docs/a", { hello: "world" });
    expect(version).toMatch(/^"[0-9a-f]{40}"$/);
    expect(await readDoc("docs/a")).toEqual({ value: { hello: "world" }, version });
    expect(await readDoc("docs/missing")).toBeNull();
    expect(blob.strayHosts).toEqual([]);
  });

  it("writes privately, without a random suffix, as JSON", async () => {
    const kv = await load();
    await kv.put("docs/a", "{}");
    const [put] = blob.requests("put", "t/docs/a");
    expect(put?.headers).toMatchObject({
      "x-vercel-blob-access": "private",
      "x-add-random-suffix": "0",
      "x-allow-overwrite": "1",
      "x-content-type": "application/json; charset=utf-8",
    });
    expect(put?.headers["x-if-match"]).toBeUndefined();
    expect(blob.objects.get("t/docs/a")?.contentType).toBe("application/json; charset=utf-8");
  });

  it("creates only when absent: a second create is a conflict, not an overwrite", async () => {
    const { KvConflictError } = await import("../agent/lib/store/kv");
    const kv = await load();
    await kv.put("inbox/e1", "first", { expectedVersion: null });
    expect(blob.requests("put", "t/inbox/e1")[0]?.headers["x-allow-overwrite"]).toBe("0");
    await expect(kv.put("inbox/e1", "second", { expectedVersion: null })).rejects.toBeInstanceOf(KvConflictError);
    expect(blob.text("t/inbox/e1")).toBe("first");
  });

  it("compares and sets on the ETag: a stale or unknown version is a conflict", async () => {
    const { KvConflictError } = await import("../agent/lib/store/kv");
    const kv = await load();
    const v1 = await kv.put("doc", "A");
    const v2 = await kv.put("doc", "B", { expectedVersion: v1 });
    expect(v2).not.toBe(v1);
    expect(blob.requests("put", "t/doc")[1]?.headers["x-if-match"]).toBe(v1);
    await expect(kv.put("doc", "C", { expectedVersion: v1 })).rejects.toBeInstanceOf(KvConflictError);
    await expect(kv.put("nope", "C", { expectedVersion: v1 })).rejects.toBeInstanceOf(KvConflictError);
    expect(blob.text("t/doc")).toBe("B");
    expect(blob.objects.has("t/nope")).toBe(false);
  });

  it("does not version by content: writing the same bytes back invalidates the old ETag (no ABA)", async () => {
    const { KvConflictError } = await import("../agent/lib/store/kv");
    const kv = await load();
    const first = await kv.put("doc", "A");
    await kv.put("doc", "B");
    const again = await kv.put("doc", "A");
    expect(again).not.toBe(first);
    await expect(kv.put("doc", "C", { expectedVersion: first })).rejects.toBeInstanceOf(KvConflictError);
  });

  it("strips the weak ETag a large read comes back with, so updates to large documents still match", async () => {
    const { readDoc, writeDoc, updateDoc } = await import("../agent/lib/store/index");
    const big = { filler: "x".repeat(4096), n: 0 };
    await writeDoc("big", big);
    const read = await readDoc<typeof big>("big");
    expect(read?.version.startsWith("W/")).toBe(false);
    expect(blob.requests("read", "t/big").length).toBeGreaterThan(0);
    await updateDoc<typeof big>("big", (current) => (current === null ? null : { ...current, n: current.n + 1 }));
    expect(JSON.parse(blob.text("t/big") ?? "{}").n).toBe(1);
    expect(blob.requests("put", "t/big").map((entry) => entry.status)).toEqual([200, 200]);
  });

  it("reads around the CDN cache, so a read-modify-write never starts from a stale version", async () => {
    const kv = await load();
    await kv.put("doc", "A");
    // Fill the CDN's copy with a cached read, as any other reader of the URL could.
    const { get } = await import("@vercel/blob");
    const cached = await get("t/doc", { access: "private" });
    await new Response(cached?.stream).text();
    const v2 = await kv.put("doc", "B");
    const before = blob.requests("read", "t/doc").length;
    expect(await kv.get("doc")).toEqual({ value: "B", version: v2 });
    expect(blob.requests("read", "t/doc").slice(before).map((entry) => entry.query.cache)).toEqual(["0"]);
    // The fake's CDN really is stale: a cached read still says A.
    const stale = await get("t/doc", { access: "private" });
    expect(await new Response(stale?.stream).text()).toBe("A");
  });

  it("lists every page under a prefix, in order, without the store prefix", async () => {
    blob.pageSize = 3;
    const kv = await load();
    for (const name of ["b/3", "a/1", "b/1", "b/2", "b/5", "b/4", "b/6", "c/1"]) await kv.put(name, name);
    expect(await kv.list("b/")).toEqual(["b/1", "b/2", "b/3", "b/4", "b/5", "b/6"]);
    expect(blob.requests("list").length).toBe(2);
    expect(await kv.list("z/")).toEqual([]);
  });

  it("deletes, and a deleted key can be created again", async () => {
    const kv = await load();
    await kv.put("inbox/e1", "x", { expectedVersion: null });
    await kv.delete("inbox/e1");
    expect(await kv.get("inbox/e1")).toBeNull();
    await expect(kv.put("inbox/e1", "y", { expectedVersion: null })).resolves.toBeTypeOf("string");
  });

  it("round-trips bytes", async () => {
    const kv = await load();
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    await kv.putBytes("files/x.bin", bytes);
    expect(blob.objects.get("t/files/x.bin")?.contentType).toBe("application/octet-stream");
    expect(Array.from((await kv.getBytes("files/x.bin")) ?? [])).toEqual([0, 1, 2, 250, 255]);
    expect(await kv.getBytes("files/missing.bin")).toBeNull();
  });

  it("treats the live service's 'conflicting operation' refusal as a lost race, so updateDoc re-reads and lands once", async () => {
    vi.stubEnv("BOT_STORE", "blob");
    const store = await import("../agent/lib/store");
    await store.writeDoc("docs/busy", { n: 1 });
    blob.inject({ kind: "conflicting-operation", op: "put", pathname: "t/docs/busy", times: 2 });
    expect(await store.updateDoc<{ n: number }>("docs/busy", (current) => ({ n: (current?.n ?? 0) + 1 }))).toEqual({ n: 2 });
    expect((await store.readDoc<{ n: number }>("docs/busy"))?.value).toEqual({ n: 2 });
    expect(blob.requests("put", "t/docs/busy").map((request) => request.status)).toEqual([200, 409, 409, 200]);
  });

  it("does not take that refusal for a lost race on an unconditional write", async () => {
    const { blobKv } = await import("../agent/lib/store/blob");
    const { KvConflictError } = await import("../agent/lib/store/kv");
    blob.inject({ kind: "conflicting-operation", op: "put", pathname: "t/docs/plain" });
    const kv = blobKv("t");
    await expect(kv.put("docs/plain", "{}")).rejects.not.toBeInstanceOf(KvConflictError);
  });

  it("rides out a 5xx before the write: the SDK retries and the write lands once", async () => {
    const kv = await load();
    blob.inject({ kind: "fail-before", op: "put", pathname: "t/doc" });
    const version = await kv.put("doc", "A", { expectedVersion: null });
    expect(blob.requests("put", "t/doc").map((entry) => [entry.status, entry.attempt])).toEqual([
      [503, 0],
      [200, 1],
    ]);
    expect(await kv.get("doc")).toEqual({ value: "A", version });
  });

  it("reports a conditional write whose response was lost as a conflict, though it landed (decision 0001)", async () => {
    // The hazard every caller has to absorb: the SDK retries the PUT, the
    // retry meets our own write, and the service refuses it.
    const { KvConflictError } = await import("../agent/lib/store/kv");
    const kv = await load();
    const v1 = await kv.put("doc", "A");
    blob.inject({ kind: "lose-response", op: "put", pathname: "t/doc" });
    await expect(kv.put("doc", "B", { expectedVersion: v1 })).rejects.toBeInstanceOf(KvConflictError);
    expect(blob.text("t/doc")).toBe("B");
    expect(blob.requests("put", "t/doc").slice(1).map((entry) => [entry.status, entry.attempt])).toEqual([
      ["dropped", 0],
      [412, 1],
    ]);

    blob.inject({ kind: "lose-response", op: "put", pathname: "t/new" });
    await expect(kv.put("new", "N", { expectedVersion: null })).rejects.toBeInstanceOf(KvConflictError);
    expect(blob.text("t/new")).toBe("N");
  });

  it("applies an unconditional write twice when its response is lost, harmlessly", async () => {
    const kv = await load();
    blob.inject({ kind: "lose-response", op: "put", pathname: "t/doc" });
    const version = await kv.put("doc", "A");
    expect(await kv.get("doc")).toEqual({ value: "A", version });
    expect(blob.requests("put", "t/doc").map((entry) => entry.status)).toEqual(["dropped", 200]);
  });

  it("applies a non-idempotent updateDoc mutate twice under a lost response: why every mutate must recognise itself", async () => {
    const { updateDoc, readDoc, writeDoc } = await import("../agent/lib/store/index");
    await writeDoc("counter", { n: 0 });
    blob.inject({ kind: "lose-response", op: "put", pathname: "t/counter" });
    await updateDoc<{ n: number }>("counter", (current) => ({ n: (current?.n ?? 0) + 1 }));
    expect((await readDoc<{ n: number }>("counter"))?.value).toEqual({ n: 2 });
  });
});
