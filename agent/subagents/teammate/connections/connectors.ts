import { defineDynamic } from "eve/connections";

import { connectorConnection } from "../../../lib/connector-connection";
import { listConnectors } from "../../../lib/connectors";
import { operator } from "../../../lib/session";

/**
 * The team's connectors, for every Bot at work.
 *
 * Connectors are account-wide: whatever the workspace connected on the
 * Connectors page is available to each job's Bot, under the connector's name
 * (`<name>__<tool>`, found with `connection_search`). Keys are unsealed only
 * when eve connects to the server, read from the stored connector each time,
 * and never shown to the model.
 *
 * The gate decides when a person is asked: never, before any tool recorded
 * as a change (a name nobody anticipated counts as one), or before every
 * tool's first use in a job. Reads under a "writes" gate flow without a
 * prompt. The gate, the policy, and the tool switches are read live on every
 * call, and the set is resolved again each turn (see `connector-connection.ts`).
 */
async function resolve(ctx: Parameters<typeof operator>[0]) {
  const { workspaceId } = operator(ctx);
  const entries = (await listConnectors(workspaceId))
    .map((connector) => [connector.name, connectorConnection(connector, "bot")] as const)
    .filter((entry): entry is readonly [string, NonNullable<(typeof entry)[1]>] => entry[1] !== null);
  return entries.length === 0 ? null : Object.fromEntries(entries);
}

export default defineDynamic({
  events: {
    "session.started": (_event, ctx) => resolve(ctx),
    "turn.started": (_event, ctx) => resolve(ctx),
  },
});
