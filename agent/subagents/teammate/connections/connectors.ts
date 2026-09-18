import { defineDynamic, defineMcpClientConnection } from "eve/connections";
import { once } from "eve/tools/approval";

import { isWriteTool } from "../../../lib/catalog";
import { connectorHeaders, listConnectors } from "../../../lib/connectors";
import { operator } from "../../../lib/session";

/**
 * The team's connectors, for every Bot at work.
 *
 * Connectors are account-wide: whatever the workspace connected on the
 * Connectors page is available to each job's Bot, under the connector's name
 * (`<name>__<tool>`, found with `connection_search`). Keys are unsealed here,
 * held only in memory for the session, and never shown to the model.
 *
 * The gate decides when a person is asked: never, before any tool that
 * changes something (by the verb in its name), or before every tool's first
 * use in a job. Reads under a "writes" gate flow without a prompt.
 */
export default defineDynamic({
  events: {
    "session.started": async (_event, ctx) => {
      const { workspaceId } = operator(ctx);
      const connectors = (await listConnectors(workspaceId)).filter((connector) => connector.enabled);
      if (connectors.length === 0) return null;

      const entries = await Promise.all(
        connectors.map(async (connector) => {
          const headers = await connectorHeaders(connector);
          return [
            connector.name,
            defineMcpClientConnection({
              url: connector.url,
              description: connector.description,
              instanceKey: connector.id,
              ...(Object.keys(headers).length === 0
                ? {}
                : { headers: Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, () => value])) }),
              ...(connector.gate === "all"
                ? { approval: once() }
                : connector.gate === "writes"
                  ? { approval: ({ toolName }: { toolName: string }) => (isWriteTool(toolName) ? "user-approval" : "not-applicable") }
                  : {}),
            }),
          ] as const;
        }),
      );
      return Object.fromEntries(entries);
    },
  },
});
