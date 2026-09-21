import { expect } from "../harness.mjs";

/**
 * Memory is what the operator sees when they ask "what does it know about me".
 * A write that does not come back, or a delete that does not delete, is worse
 * than no memory at all; a password that lands is worse still.
 */
export default [
  {
    name: "memory: what is written comes back, and what is deleted stays deleted",
    run: async ({ call }) => {
      const line = `QA fixture ${Math.random().toString(36).slice(2, 8)}: prefers the QA suite to leave no trace.`;
      const added = await call("/bot/v1/memory/team", { method: "POST", body: { text: line, kind: "rule" } });
      expect(added.status, 201, "adding a memory", { body: added.body });
      const id = added.body?.entry?.id;
      expect(typeof id, "string", "the new memory has an id", { body: added.body });

      const read = await call("/bot/v1/memory");
      expect(read.status, 200, "reading memory", { body: read.body });
      const slot = read.body?.slots?.find((entry) => entry.slot === "team");
      const stored = slot?.entries?.find((entry) => entry.id === id);
      expect(stored?.text, line, "the line is in the team slot, as written", { slot });
      expect(stored?.source?.who, "you", "it is marked as added by hand", { stored });

      // The same words twice is one memory, not two.
      const again = await call("/bot/v1/memory/team", { method: "POST", body: { text: line } });
      expect(again.status, 409, "a word-for-word repeat is refused", { body: again.body });

      // Secrets never land, whatever the caller says.
      const secret = await call("/bot/v1/memory/team", { method: "POST", body: { text: "The shared password is hunter2" } });
      expect(secret.status, 400, "a password is refused", { body: secret.body });

      const pinned = await call(`/bot/v1/memory/team/${encodeURIComponent(id)}`, { method: "PATCH", body: { pinned: true } });
      expect(pinned.status, 200, "pinning the memory", { body: pinned.body });

      const removed = await call(`/bot/v1/memory/team/${encodeURIComponent(id)}`, { method: "DELETE" });
      expect(removed.status, 200, "deleting the memory", { body: removed.body });

      const after = await call("/bot/v1/memory");
      const stillThere = after.body?.slots?.find((entry) => entry.slot === "team")?.entries?.some((entry) => entry.id === id);
      expect(stillThere ?? false, false, "the deleted line is gone", { after: after.body });
    },
  },
];
