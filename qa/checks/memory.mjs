import { expect } from "../harness.mjs";

/**
 * Memory is what the operator sees when they ask "what does it know about me".
 * A write that does not come back, or a delete that does not delete, is worse
 * than no memory at all.
 */
export default [
  {
    name: "memory: what is written comes back, and what is deleted stays deleted",
    run: async ({ call }) => {
      const line = `QA fixture ${Date.now()}`;
      const added = await call("/bot/v1/memory/team", { method: "POST", body: { text: line } });
      // A workspace nobody has messaged yet has no memory document to write to,
      // which is the product working, not a failure.
      if (added.status === 409 && /starts this memory/i.test(added.body?.error ?? "")) {
        return { skipped: "memory not started on this deployment yet" };
      }
      expect(added.status, (status) => status === 200 || status === 201, "adding a memory", { body: added.body });

      const read = await call("/bot/v1/memory");
      expect(read.status, 200, "reading memory", { body: read.body });
      const slot = read.body?.slots?.find((entry) => entry.slot === "team");
      const index = slot?.items?.findIndex((item) => (typeof item === "string" ? item : item?.text)?.includes(line));
      expect(typeof index === "number" && index >= 0, true, "the line is in the team slot", { slot });

      const removed = await call(`/bot/v1/memory/team/${index}`, { method: "DELETE" });
      expect(removed.status, (status) => status === 200 || status === 204, "deleting the memory", { body: removed.body });

      const after = await call("/bot/v1/memory");
      const stillThere = after.body?.slots
        ?.find((entry) => entry.slot === "team")
        ?.items?.some((item) => (typeof item === "string" ? item : item?.text)?.includes(line));
      expect(stillThere ?? false, false, "the deleted line is gone", { after: after.body });
    },
  },
];
