import { defineDynamic, defineInstructions } from "eve/instructions";

import { listPlugins } from "../lib/plugins";
import { operator } from "../lib/session";

/**
 * The plugins the team connected, so HQ routes work that needs one to a Bot.
 *
 * Plugins belong to the Bots, as in Grok Bot: HQ does not call them itself, but
 * it has to know they exist, or it tells the operator a plugin is missing.
 * Resolved per turn so a plugin added or switched off lands at once.
 */
export default defineDynamic({
  events: {
    "turn.started": async (_event, ctx) => {
      const { workspaceId } = operator(ctx);
      const plugins = (await listPlugins(workspaceId)).filter((plugin) => plugin.enabled);
      if (plugins.length === 0) return null;

      return defineInstructions({
        content: [
          "## Plugins",
          "",
          "The team connected these plugins (MCP servers). Every Bot can use them while it works; you cannot call them yourself.",
          "",
          ...plugins.map((plugin) => `- ${plugin.label} (\`${plugin.name}\`): ${plugin.description}`),
          "",
          "When a request needs one of them, assign it to a Bot as usual and name the plugin in the brief, so the Bot uses it instead of the browser. Never tell the operator a listed plugin is unavailable.",
        ].join("\n"),
      });
    },
  },
});
