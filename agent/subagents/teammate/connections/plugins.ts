import { defineDynamic, defineMcpClientConnection } from "eve/connections";
import { once } from "eve/tools/approval";

import { listPlugins, pluginHeaders } from "../../../lib/plugins";
import { operator } from "../../../lib/session";

/**
 * The team's plugins, for every Bot at work.
 *
 * Plugins are account-wide, as in Grok Bot: whatever the workspace connected on
 * the Plugins page is available to each job's Bot, under the plugin's name
 * (`<name>__<tool>`, found with `connection_search`). Keys are unsealed here,
 * held only in memory for the session, and never shown to the model.
 */
export default defineDynamic({
  events: {
    "session.started": async (_event, ctx) => {
      const { workspaceId } = operator(ctx);
      const plugins = (await listPlugins(workspaceId)).filter((plugin) => plugin.enabled);
      if (plugins.length === 0) return null;

      const entries = await Promise.all(
        plugins.map(async (plugin) => {
          const headers = await pluginHeaders(plugin);
          return [
            plugin.name,
            defineMcpClientConnection({
              url: plugin.url,
              description: plugin.description,
              instanceKey: plugin.id,
              ...(Object.keys(headers).length === 0
                ? {}
                : { headers: Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, () => value])) }),
              ...(plugin.askFirst ? { approval: once() } : {}),
            }),
          ] as const;
        }),
      );
      return Object.fromEntries(entries);
    },
  },
});
