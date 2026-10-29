import { defineDynamic } from "eve/connections";

import { connectorConnection } from "../lib/connector-connection";
import { listConnectors } from "../lib/connectors";
import { perTurn } from "../lib/dynamic";
import { operator } from "../lib/session";

/**
 * The team's connectors, for HQ, reads only.
 *
 * A question a connector can answer in a call or two ("what is open on the
 * repo?") should be answered in the thread, not turned into a job. So HQ gets
 * each enabled connector with only the tools a person confirmed only read on
 * the Connectors page (or the catalog vouches for). A read guessed from a
 * tool's name is not enough here: HQ has no approval gate, so anything that
 * might change something stays with a Bot and its gate (see the teammate's
 * connections).
 *
 * Read again every turn, so settings changed on the Connectors page reach a
 * running conversation; every call is
 * also checked against the live record (see `connector-connection.ts`).
 */
async function resolve(ctx: Parameters<typeof operator>[0] & Parameters<typeof perTurn>[0]) {
  const { workspaceId } = operator(ctx);
  // Read once a turn: the records are kept with the session, sealed as they are stored.
  const entries = (await perTurn(ctx, () => listConnectors(workspaceId)))
    .map((connector) => [connector.name, connectorConnection(connector, "hq")] as const)
    .filter((entry): entry is readonly [string, NonNullable<(typeof entry)[1]>] => entry[1] !== null);
  return entries.length === 0 ? null : Object.fromEntries(entries);
}

export default defineDynamic((ctx) => resolve(ctx));
