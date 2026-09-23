import { ConnectionAuthorizationRequiredError, defineDynamic, defineMcpClientConnection } from "eve/connections";

import { allowedTools, connectorHeaders, connectorToken, getConnector, listConnectors } from "../lib/connectors";
import { operator } from "../lib/session";

/**
 * The team's connectors, for HQ, reads only.
 *
 * A question a connector can answer in a call or two ("what is open on the
 * repo?") should be answered in the thread, not turned into a job. So HQ gets
 * each enabled connector with only the tools that read, chosen by the verb in
 * the tool's name from what the server listed when it was connected. Anything
 * that changes something is not offered here at all; that stays with a Bot
 * and its approval gate (see the teammate's connections).
 */
export default defineDynamic({
  events: {
    "session.started": async (_event, ctx) => {
      const { workspaceId } = operator(ctx);
      const connectors = (await listConnectors(workspaceId)).filter((connector) => connector.enabled && connector.check.tools.length > 0);
      const entries = await Promise.all(
        connectors.map(async (connector) => {
          const reads = allowedTools(connector, { readsOnly: true });
          if (reads.length === 0) return null;
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
              description: `${connector.description} (read-only for HQ)`,
              instanceKey: connector.id,
              ...auth,
              tools: { allow: reads },
              ...(Object.keys(headers).length === 0
                ? {}
                : { headers: Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, () => value])) }),
            }),
          ] as const;
        }),
      );
      const present = entries.filter((entry): entry is NonNullable<typeof entry> => entry !== null);
      return present.length === 0 ? null : Object.fromEntries(present);
    },
  },
});
