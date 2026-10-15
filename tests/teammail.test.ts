import { beforeEach, describe, expect, it, vi } from "vitest";

/** Teammates' notes to each other: posted to an outbox, delivered once into the other's thread, rate-limited. */

const WORKSPACE = "default";

describe("teammail", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("BOT_STORE", "memory");
  });

  it("delivers a note into the teammate's thread once, reading as from the sender", async () => {
    const mail = await import("../agent/lib/teammail");
    const posted = await mail.postNote({
      workspaceId: WORKSPACE,
      from: { name: "Ava", room: "bot-bot_a" },
      to: { name: "HQ", room: "desk" },
      text: "Which inbox did you mean?",
    });
    expect(posted.ok).toBe(true);
    const sent: { room: string; message: string }[] = [];
    const send = async (_workspaceId: string, room: string, message: string) => {
      sent.push({ room, message });
    };
    expect(await mail.deliverNotes(send)).toBe(1);
    expect(await mail.deliverNotes(send)).toBe(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.room).toBe("desk");
    expect(mail.TEAMMATE_MESSAGE.exec(sent[0]?.message ?? "")?.[1]).toBe("Ava");
    expect(sent[0]?.message).toContain("Which inbox did you mean?");
  });

  it("keeps a note whose delivery failed for a later pass", async () => {
    const mail = await import("../agent/lib/teammail");
    await mail.postNote({ workspaceId: WORKSPACE, from: { name: "Ava", room: "bot-a" }, to: { name: "Atlas", room: "bot-b" }, text: "hi" });
    const now = Date.now();
    expect(await mail.deliverNotes(async () => Promise.reject(new Error("down")), { now })).toBe(0);
    // Still claimed a moment later, free again once the claim lapses.
    expect(await mail.deliverNotes(async () => undefined, { now: now + 1000 })).toBe(0);
    expect(await mail.deliverNotes(async () => undefined, { now: now + 120_000 })).toBe(1);
  });

  it("limits how often one teammate can message another", async () => {
    const mail = await import("../agent/lib/teammail");
    const note = { workspaceId: WORKSPACE, from: { name: "Ava", room: "bot-a" }, to: { name: "Atlas", room: "bot-b" }, text: "again" };
    const now = Date.now();
    for (let index = 0; index < mail.NOTES_PER_WINDOW; index += 1) expect((await mail.postNote({ ...note, now })).ok).toBe(true);
    expect((await mail.postNote({ ...note, now })).ok).toBe(false);
    // The other direction has its own allowance, and the window moves on.
    expect((await mail.postNote({ ...note, from: note.to, to: note.from, now })).ok).toBe(true);
    expect((await mail.postNote({ ...note, now: now + mail.NOTE_WINDOW_MS + 1 })).ok).toBe(true);
  });
});
