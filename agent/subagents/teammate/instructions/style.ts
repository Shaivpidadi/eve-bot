import { defineDynamic, defineInstructions } from "eve/instructions";

import { styleInstructions } from "../../../lib/memory/style";
import { operator } from "../../../lib/session";

/**
 * How the person wants things written, as instructions rather than as
 * recalled data, so a rule like "no em dashes" holds in chat replies as well
 * as in drafts. Read per turn, so a change on the Memory page lands at once.
 */
export default defineDynamic({
  events: {
    "turn.started": async (_event, ctx) => {
      const content = await styleInstructions(operator(ctx).workspaceId).catch(() => null);
      return content === null ? null : defineInstructions({ content });
    },
  },
});
