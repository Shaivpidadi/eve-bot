import { PassThrough, Readable } from "node:stream";

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A workspace exported from one store and imported into another comes back
 * byte for byte, except for what cannot move: an open job's lease and a
 * room's session, which name things in the old Workflow state.
 */

async function collect(write: (out: PassThrough) => Promise<unknown>): Promise<Buffer> {
  const out = new PassThrough();
  const chunks: Buffer[] = [];
  out.on("data", (chunk: Buffer) => chunks.push(chunk));
  await write(out);
  return Buffer.concat(chunks);
}

async function seeded() {
  const { inMemoryKv } = await import("../agent/lib/store/memory");
  const kv = inMemoryKv();
  await kv.put("jobs/default/job_open.json", JSON.stringify({ id: "job_open", botId: "bot_1", title: "Open", status: "running", lease: { token: "t", kind: "run", until: "2099-01-01T00:00:00.000Z" } }));
  await kv.put("jobs/default/job_done.json", JSON.stringify({ id: "job_done", botId: "bot_1", title: "Done", status: "done", lease: null }));
  await kv.put("rooms/default/desk.json", JSON.stringify({ workspaceId: "default", room: "desk", sessionId: "sess_1", active: true, pending: [{ id: 1 }] }));
  await kv.put("memory/v2/default/profile.json", JSON.stringify({ entries: [{ id: "m1", text: "Prefers American spelling" }] }));
  await kv.put("connectors/default/linear.json", JSON.stringify({ sealed: "abc" }));
  await kv.put("jobs/other/job_x.json", JSON.stringify({ id: "job_x", status: "done", lease: null }));
  await kv.put("odd/key with spaces%2F.json", JSON.stringify({ ok: true }));
  await kv.put("computer/bot-computer/access-key.json", JSON.stringify({ key: "k" }));
  await kv.putBytes("computer/bot-computer/backup-1.tgz", new Uint8Array([0x1f, 0x8b, 0, 255, 254, 7]));
  return kv;
}

describe("export and import", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("round-trips every document and binary object, settling what cannot move", async () => {
    const transfer = await import("../agent/lib/store/transfer");
    const source = await seeded();
    const archive = await collect((out) => transfer.exportTo(source, out, { version: "0.2.0" }));

    // A second, empty store: the memory driver is process-wide, so reset the module.
    vi.resetModules();
    const { inMemoryKv } = await import("../agent/lib/store/memory");
    const fresh = await import("../agent/lib/store/transfer");
    const target = inMemoryKv();
    expect(await target.list("")).toEqual([]);

    const outcome = await fresh.importFrom(target, Readable.from(archive));
    expect(outcome.manifest).toMatchObject({ format: "eve-bot-export/1", version: "0.2.0", counts: { docs: 8, bytes: 1 } });
    expect(outcome.written).toBe(9);
    expect(outcome.movedJobs).toEqual([{ workspaceId: "default", jobId: "job_open", botId: "bot_1", title: "Open" }]);
    expect(outcome.rooms).toBe(1);

    expect(await target.list("")).toEqual(await source.list(""));
    expect(await target.getBytes("computer/bot-computer/backup-1.tgz")).toEqual(new Uint8Array([0x1f, 0x8b, 0, 255, 254, 7]));
    expect(JSON.parse((await target.get("memory/v2/default/profile.json"))!.value)).toEqual({ entries: [{ id: "m1", text: "Prefers American spelling" }] });
    expect(JSON.parse((await target.get("odd/key with spaces%2F.json"))!.value)).toEqual({ ok: true });
    expect(JSON.parse((await target.get("jobs/default/job_open.json"))!.value)).toMatchObject({ status: "running", lease: null });
    expect(JSON.parse((await target.get("jobs/default/job_done.json"))!.value)).toMatchObject({ status: "done", lease: null });
    expect(JSON.parse((await target.get("rooms/default/desk.json"))!.value)).toMatchObject({ sessionId: null, active: false, pending: [] });
  });

  it("exports one workspace, and leaves secrets out when asked", async () => {
    const transfer = await import("../agent/lib/store/transfer");
    const source = await seeded();
    const keys = await transfer.keysToExport(source, { workspace: "default", secrets: false });
    expect(keys).toContain("jobs/default/job_open.json");
    expect(keys).toContain("memory/v2/default/profile.json");
    expect(keys).not.toContain("jobs/other/job_x.json");
    expect(keys).not.toContain("connectors/default/linear.json");
    expect(keys).not.toContain("computer/bot-computer/backup-1.tgz");
    expect(keys).not.toContain("computer/bot-computer/access-key.json");
    // With secrets, the key the workspace's connectors are sealed with goes along.
    expect(await transfer.keysToExport(source, { workspace: "default" })).toContain("computer/bot-computer/access-key.json");
  });

  it("skips, fails, or does nothing on a dry run, as asked", async () => {
    const transfer = await import("../agent/lib/store/transfer");
    const source = await seeded();
    const archive = await collect((out) => transfer.exportTo(source, out));
    await source.put("memory/v2/default/profile.json", JSON.stringify({ entries: [] }));

    const skipped = await transfer.importFrom(source, Readable.from(archive), { onConflict: "skip" });
    expect(skipped).toMatchObject({ written: 0, skipped: 9 });
    expect(JSON.parse((await source.get("memory/v2/default/profile.json"))!.value)).toEqual({ entries: [] });

    await expect(transfer.importFrom(source, Readable.from(archive), { onConflict: "fail" })).rejects.toThrow(/already exists/);

    const dry = await transfer.importFrom(source, Readable.from(archive), { dryRun: true });
    expect(dry.written).toBe(9);
    expect(JSON.parse((await source.get("memory/v2/default/profile.json"))!.value)).toEqual({ entries: [] });
  });

  it("refuses something that is not an export", async () => {
    const transfer = await import("../agent/lib/store/transfer");
    const { inMemoryKv } = await import("../agent/lib/store/memory");
    const { gzipSync } = await import("node:zlib");
    await expect(transfer.importFrom(inMemoryKv(), Readable.from(gzipSync('{"format":"other"}\n')))).rejects.toThrow(/Not an EVE BOT export/);
  });
});

describe("the export route's switch", () => {
  it("is off unless the deployment opts in", async () => {
    const { exportEnabled } = await import("../agent/lib/store/transfer");
    expect(exportEnabled({})).toBe(false);
    expect(exportEnabled({ BOT_EXPORT: "on" })).toBe(true);
    expect(exportEnabled({ BOT_EXPORT: "1" })).toBe(true);
    expect(exportEnabled({ BOT_EXPORT: "off" })).toBe(false);
  });
});
