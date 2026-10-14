import { agentRuns, composeSpanExportPolicies, redactSpanInputs, redactSpanOutputs } from "eve/instrumentation/otel";

import { tracingNow } from "../lib/tracing-settings";

/**
 * Vercel Agent Runs: every HQ, Bot and job session as a trace in the project's
 * Observability tab, on preview and production deployments. Settings turns
 * the export off, or lets content through; checked for every span, so a change
 * applies to runs already going.
 */
export default agentRuns({
  exportPolicy: composeSpanExportPolicies(
    { span: () => tracingNow().agentRuns },
    redactSpanInputs(() => !tracingNow().content),
    redactSpanOutputs(() => !tracingNow().content),
  ),
});
