import { defineDynamic, defineInstructions } from "eve/instructions";

import { listConnectors } from "../lib/connectors";
import { operator } from "../lib/session";

/**
 * The connectors the team connected, so HQ routes work that needs one to a Bot.
 *
 * Connectors belong to the Bots: HQ does not call them itself, but it has to
 * know they exist, or it tells the operator a service is missing. Resolved per
 * turn so a connector added or switched off lands at once.
 */
export default defineDynamic({
  events: {
    "turn.started": async (_event, ctx) => {
      const { workspaceId } = operator(ctx);
      const connectors = (await listConnectors(workspaceId)).filter((connector) => connector.enabled);
      if (connectors.length === 0) return null;

      return defineInstructions({
        content: [
          "## Connectors",
          "",
          "The team connected these services. Every Bot can use them while it works; you cannot call them yourself.",
          "",
          ...connectors.map((connector) => `- ${connector.label} (\`${connector.name}\`): ${connector.description}`),
          "",
          "When a request needs one of them, assign it to a Bot as usual and name the connector in the brief, so the Bot uses it instead of the browser. Never tell the operator a listed service is unavailable.",
        ].join("\n"),
      });
    },
  },
});
