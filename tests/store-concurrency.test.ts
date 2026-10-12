import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fileKv } from "../agent/lib/store/fs";
import { KvConflictError } from "../agent/lib/store/kv";

/**
 * The invariants M1 builds on, each expressed as a single-document
 * compare-and-set (docs/decisions/0001-state-store.md). They run against the
 * two backends that work without credentials. Blob runs the same invariants,
 * across several runtimes and with lost answers, against a fake of the Blob
 * service in `store-blob-invariants.test.ts`.
 */
const backends = ["memory", "fs"] as const;

describe.each(backends)("single-document invariants on the %s store", (backend) => {
  let root: string;

  beforeEach(async () => {
    vi.resetModules();
    root = await mkdtemp(join(tmpdir(), "bot-store-cc-"));
    vi.stubEnv("BOT_STORE", backend);
    vi.stubEnv("BOT_DATA_DIR", root);
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  const load = () => import("../agent/lib/store/index");
  const fresh = (name: string) => `test/${name}/${Math.random().toString(36).slice(2)}`;

  it("loses no increments when many updates overlap", async () => {
    const { updateDoc, readDoc } = await load();
    const key = fresh("counter");
    await Promise.all(
      Array.from({ length: 40 }, () => updateDoc<{ n: number }>(key, (current) => ({ n: (current?.n ?? 0) + 1 }))),
    );
    expect((await readDoc<{ n: number }>(key))?.value).toEqual({ n: 40 });
  });

  it("lets exactly one of many simultaneous claims win", async () => {
    const { updateDoc, readDoc, writeDoc } = await load();
    const key = fresh("claim");
    await writeDoc(key, { owner: null as string | null, fence: 0 });
    const workers = Array.from({ length: 16 }, (_, i) => `run-${i}`);
    const results = await Promise.all(
      workers.map((run) =>
        updateDoc<{ owner: string | null; fence: number }>(key, (current) =>
          current === null || current.owner !== null ? null : { owner: run, fence: current.fence + 1 },
        ),
      ),
    );
    const winners = results.filter((result) => result !== null);
    expect(winners).toHaveLength(1);
    expect((await readDoc(key))?.value).toEqual({ owner: winners[0]?.owner, fence: 1 });
  });

  it("never reserves past a workspace budget limit", async () => {
    // One budget document per workspace: the limit check and the reservation are the same write.
    const { updateDoc, readDoc, writeDoc } = await load();
    interface Budget {
      limit: number;
      reserved: number;
      reservations: Record<string, number>;
    }
    const key = fresh("budget");
    await writeDoc<Budget>(key, { limit: 100, reserved: 0, reservations: {} });
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        updateDoc<Budget>(key, (current) => {
          if (current === null || current.reserved + 15 > current.limit) return null;
          return {
            ...current,
            reserved: current.reserved + 15,
            reservations: { ...current.reservations, [`run-${i}`]: 15 },
          };
        }),
      ),
    );
    const budget = (await readDoc<Budget>(key))?.value;
    expect(results.filter((result) => result !== null)).toHaveLength(6);
    expect(budget?.reserved).toBe(90);
    expect(Object.keys(budget?.reservations ?? {})).toHaveLength(6);
    expect(Object.values(budget?.reservations ?? {}).reduce((sum, amount) => sum + amount, 0)).toBe(budget?.reserved);
  });

  it("moves an approval out of `proposed` exactly once", async () => {
    const { updateDoc, readDoc, writeDoc } = await load();
    type Action = { state: "proposed" | "approved" | "rejected"; by: string | null };
    const key = fresh("action");
    await writeDoc<Action>(key, { state: "proposed", by: null });
    const decisions = ["approved", "rejected", "approved", "rejected", "approved"] as const;
    const results = await Promise.all(
      decisions.map((state, i) =>
        updateDoc<Action>(key, (current) =>
          current?.state === "proposed" ? { state, by: `reviewer-${i}` } : null,
        ),
      ),
    );
    const applied = results.filter((result) => result !== null);
    expect(applied).toHaveLength(1);
    expect((await readDoc<Action>(key))?.value).toEqual(applied[0]);
  });

  it("creates a key exactly once under simultaneous create-if-absent writes", async () => {
    // The event-inbox dedupe shape: the provider event ID is the key.
    const { writeDoc, readDoc, isConflict } = await load();
    const key = fresh("inbox");
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, (_, i) => writeDoc(key, { delivery: i }, null)),
    );
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const conflicts = results.filter((result) => result.status === "rejected" && isConflict(result.reason));
    expect(fulfilled).toHaveLength(1);
    expect(conflicts).toHaveLength(11);
    expect((await readDoc<{ delivery: number }>(key))?.value.delivery).toBeTypeOf("number");
  });

  it("creates exactly once through updateDoc too", async () => {
    const { updateDoc, readDoc } = await load();
    const key = fresh("ledger");
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        updateDoc<{ receipt: string }>(key, (current) => (current === null ? { receipt: `r-${i}` } : null)),
      ),
    );
    const created = results.filter((result) => result !== null);
    expect(created).toHaveLength(1);
    expect((await readDoc(key))?.value).toEqual(created[0]);
  });

  it("re-reads and re-applies when another runtime commits between read and write", async () => {
    // The in-process lock cannot see a write from another runtime; the version
    // check must. The "other runtime" writes straight to the driver, after our
    // read and before our conditional write.
    const { updateDoc, readDoc, writeDoc, store } = await load();
    const key = fresh("cross");
    await writeDoc(key, { n: 0, tags: [] as string[] });
    let calls = 0;
    let other: Promise<string> | undefined;
    const result = await updateDoc<{ n: number; tags: string[] }>(key, (current) => {
      calls += 1;
      if (calls === 1) other = store().put(key, JSON.stringify({ n: 1, tags: ["other"] }));
      return { n: (current?.n ?? 0) + 1, tags: [...(current?.tags ?? []), "mine"] };
    });
    await other;
    expect(calls).toBe(2);
    expect(result).toEqual({ n: 2, tags: ["other", "mine"] });
    expect((await readDoc(key))?.value).toEqual({ n: 2, tags: ["other", "mine"] });
  });

  it("gives up with a conflict when every attempt loses", async () => {
    const { updateDoc, writeDoc, store, isConflict } = await load();
    const key = fresh("starved");
    await writeDoc(key, { n: 0 });
    let bump = 0;
    const others: Promise<string>[] = [];
    const outcome = await updateDoc<{ n: number }>(
      key,
      (current) => {
        others.push(store().put(key, JSON.stringify({ n: 1000 + (bump += 1) })));
        return { n: (current?.n ?? 0) + 1 };
      },
      2,
    ).catch((error: unknown) => error);
    expect(isConflict(outcome)).toBe(true);
    expect(bump).toBe(2);
    await Promise.all(others);
  });
});

/** Raw driver semantics the decision record relies on, beyond what updateDoc hides. */
describe("fileKv compare-and-set semantics", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "bot-store-cc-"));
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it("versions by content, so a document that returns to identical bytes accepts an old version", async () => {
    // Value-based CAS: safe for read-modify-write of the value itself, but a
    // fence that needs to detect "changed and changed back" must live in the
    // document (a counter), not in the version token.
    const kv = fileKv(root);
    const first = await kv.put("doc", "A");
    await kv.put("doc", "B");
    const again = await kv.put("doc", "A");
    expect(again).toBe(first);
    await expect(kv.put("doc", "C", { expectedVersion: first })).resolves.toBeTypeOf("string");
  });

  it("leaves no staging files behind after successful writes", async () => {
    const kv = fileKv(root);
    await Promise.all(Array.from({ length: 8 }, (_, i) => kv.put(`k/${i % 2}`, `v${i}`)));
    expect(await kv.list("k/")).toEqual(["k/0", "k/1"]);
    const { readdir } = await import("node:fs/promises");
    expect((await readdir(join(root, "k"))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("enforces create-if-absent only while the key exists: delete re-opens it", async () => {
    const kv = fileKv(root);
    await kv.put("inbox/e1", "x", { expectedVersion: null });
    await expect(kv.put("inbox/e1", "y", { expectedVersion: null })).rejects.toBeInstanceOf(KvConflictError);
    // Delete is unconditional: once removed, the key can be created again.
    await kv.delete("inbox/e1");
    await expect(kv.put("inbox/e1", "z", { expectedVersion: null })).resolves.toBeTypeOf("string");
  });
});
