import { ConnectionAuthorizationRequiredError, defineDynamic, defineMcpClientConnection } from "eve/connections";
import { once } from "eve/tools/approval";

import { effectOf } from "../../../lib/catalog";
import { allowedTools, connectorHeaders, connectorToken, getConnector, listConnectors } from "../../../lib/connectors";
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
          const allow = allowedTools(connector);
          if (allow.length === 0) return null;
          const headers = connector.auth.kind === "oauth" ? {} : await connectorHeaders(connector);
          // An OAuth connector's token is fetched per call and refreshed as needed; without a sign-in, eve is told to ask for one.
          const auth =
            connector.auth.kind !== "oauth"
              ? {}
              : {
                  auth: {
                    displayName: connector.label,
                    getToken: async () => {
                      const live = (await getConnector(connector.workspaceId, connector.id)) ?? connector;
                      const token = await connectorToken(live);
                      if (token === null) throw new ConnectionAuthorizationRequiredError(connector.name);
                      return token;
                    },
                  },
                };
          return [
            connector.name,
            defineMcpClientConnection({
              url: connector.url,
              description: connector.description,
              instanceKey: connector.id,
              ...auth,
              // Only the tools the operator left on; a server that grew new tools offers them after the next check.
              ...((connector.disabledTools ?? []).length === 0 ? {} : { tools: { allow } }),
              ...(Object.keys(headers).length === 0
                ? {}
                : { headers: Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, () => value])) }),
              ...(connector.gate === "all"
                ? { approval: once() }
                : connector.gate === "writes"
                  ? {
                      approval: ({ toolName }: { toolName: string }) =>
                        effectOf(connector.policy, toolName) === "write" ? "user-approval" : "not-applicable",
                    }
                  : {}),
            }),
          ] as const;
        }),
      );
      const present = entries.filter((entry): entry is NonNullable<typeof entry> => entry !== null);
      return present.length === 0 ? null : Object.fromEntries(present);
    },
  },
});
