import { expect } from "../harness.mjs";

/** A test bot, named so a human can see where it came from and delete it. */
const NAME = () => `QA ${Math.random().toString(36).slice(2, 7)}`;
/** Hiring needs how the bot should work, at least 20 characters of it. */
const PERSONA = "A fixture left by the QA suite. It does no work and can be retired at any time.";

export default [
  {
    name: "roster: a bot can be hired, edited, and retired",
    run: async ({ call }) => {
      const name = NAME();
      const created = await call("/bot/v1/bots", { method: "POST", body: { name, role: "QA fixture", persona: PERSONA } });
      expect(created.status, (status) => status === 200 || status === 201, "hiring a bot", { body: created.body });
      const id = created.body?.bot?.id;
      expect(typeof id, "string", "the new bot has an id", { body: created.body });

      try {
        const renamed = await call(`/bot/v1/bots/${encodeURIComponent(id)}`, { method: "PATCH", body: { role: "QA fixture, edited" } });
        expect(renamed.status, (status) => status < 300, "editing the bot", { body: renamed.body });
        expect(renamed.body?.bot?.role, "QA fixture, edited", "the edit stuck", { body: renamed.body });

        const listed = await call("/bot/v1/state");
        expect(
          listed.body?.members?.some((member) => member.id === id),
          true,
          "the bot is on the roster",
          { members: listed.body?.members?.map((member) => member.id) },
        );
      } finally {
        await call(`/bot/v1/bots/${encodeURIComponent(id)}`, { method: "DELETE" });
      }

      const after = await call("/bot/v1/state");
      expect(
        after.body?.members?.some((member) => member.id === id && member.status === "active"),
        false,
        "the retired bot is gone from the active roster",
        { members: after.body?.members?.map((member) => `${member.id}:${member.status}`) },
      );
    },
  },
  {
    name: "roster: a duplicate name is refused",
    run: async ({ call }) => {
      const name = NAME();
      const first = await call("/bot/v1/bots", { method: "POST", body: { name, role: "QA fixture", persona: PERSONA } });
      expect(first.status, (status) => status === 200 || status === 201, "hiring the first bot", { body: first.body });
      const id = first.body?.bot?.id;
      try {
        const second = await call("/bot/v1/bots", { method: "POST", body: { name, role: "QA fixture", persona: PERSONA } });
        expect(second.status, (status) => status >= 400, "hiring a second bot with the same name", { body: second.body });
      } finally {
        await call(`/bot/v1/bots/${encodeURIComponent(id)}`, { method: "DELETE" });
      }
    },
  },
];
