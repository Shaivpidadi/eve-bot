import { expect } from "../harness.mjs";

/**
 * Connectors hold keys and decide what a bot may do with someone else's
 * account. The checks here are the ones that must never regress quietly:
 * a bad address is refused, and a key never comes back out.
 */
export default [
  {
    name: "connectors: the catalog lists, and keys never come back",
    run: async ({ call }) => {
      const listed = await call("/bot/v1/connectors");
      expect(listed.status, 200, "listing connectors", { body: listed.body });
      expect(Array.isArray(listed.body?.catalog), true, "the catalog is there", { body: listed.body });
      const leaked = JSON.stringify(listed.body?.connectors ?? []).match(/"sealed"|"secret"/);
      expect(leaked, null, "no sealed key in the response", { connectors: listed.body?.connectors });
      return `${listed.body.catalog.length} in the catalog, ${listed.body.connectors?.length ?? 0} connected`;
    },
  },
  {
    name: "connectors: an address that is not a server is refused",
    run: async ({ call }) => {
      const added = await call("/bot/v1/connectors", {
        method: "POST",
        body: { label: "QA nowhere", url: "https://127.0.0.1:9/mcp", description: "QA fixture" },
        timeoutMs: 40_000,
      });
      expect(added.status, (status) => status >= 400, "adding an unreachable server", { body: added.body });
      expect(typeof added.body?.error, "string", "it says why", { body: added.body });
    },
  },
];
