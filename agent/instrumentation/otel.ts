import { otel } from "eve/instrumentation/otel";

import { tracingNow } from "../lib/tracing-settings";

/**
 * The trace ceiling for every destination: every conversation is traced, and
 * its content (prompts, tool arguments, results) only when Settings says so.
 * eve's default captures content for public conversations only, and none of
 * Bot's are public. Read when a session starts; Agent Runs also redacts per
 * span (see `agent-runs.ts`), so turning content off applies at once.
 */
export default otel({
  tracePolicy: () => {
    const { content } = tracingNow();
    return { emit: true, recordInputs: content, recordOutputs: content };
  },
});
