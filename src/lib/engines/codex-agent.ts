/**
 * The Codex agent as the Next.js app serves it: `withDurableHarness` imports
 * this module into the queue route it writes, which drives every session (see
 * `next.config.ts`). Built only with `BOT_ENGINES` on.
 *
 * The options are the same ones `run_job`'s steps use on the agent service
 * (`agent/lib/engines/codex.ts`), so both sides make the same agent.
 */
import { codex } from "durable-harness/codex";
import { sandbox } from "durable-harness/sandbox";

import { codexOptions } from "../../../agent/lib/engines/codex";

export const codexAgent = codex(codexOptions(sandbox));
