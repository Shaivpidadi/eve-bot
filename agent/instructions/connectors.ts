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
          "The team connected these services. You have their read tools yourself, found with `connection_search`; Bots have all of their tools.",
          "",
          ...connectors.map((connector) => `- ${connector.label} (\`${connector.name}\`): ${connector.description}`),
          "",
          "A lookup or a question one of them answers in a call or two, answer yourself, in this thread, right away: open issues, recent commits, a page's contents, a status. Do not assign a job for it, and do not ask which account or repository first: list what the connector can see and pick the obvious one, or ask only when several fit. When a request changes something (create, merge, send, close), or needs the browser, or takes many steps, assign it to a Bot as usual and name the connector in the brief so the Bot uses it instead of the browser. Never tell the operator a listed service is unavailable.",
        ].join("\n"),
      });
    },
  },
});
