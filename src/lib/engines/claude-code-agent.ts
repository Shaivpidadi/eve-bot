/**
 * The Claude Code agent as the Next.js app serves it: `withDurableHarness`
 * imports this module into the queue route it writes, which drives every
 * session (see `next.config.ts`). Built only with `BOT_ENGINES` on.
 *
 * The options are the same ones `run_job`'s steps use on the agent service
 * (`agent/lib/engines/claude-code.ts`), so both sides make the same agent.
 */
import { claudeCode } from "durable-harness/claude-code";
import { sandbox } from "durable-harness/sandbox";

import { claudeCodeOptions } from "../../../agent/lib/engines/claude-code";
import { registerAgentRuns } from "./agent-runs";

registerAgentRuns();

export const claudeCodeAgent = claudeCode(claudeCodeOptions(sandbox));
