import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

/**
 * Tests live in `tests/`, never under `agent/`: eve treats every module there
 * as part of the agent, and a test file next to a tool would be loaded as one.
 * Nothing here needs Vercel credentials, Docker, or a model; everything the
 * standalone server relies on is exercised in-process.
 *
 * `workflow/api` is eve's alias for its vendored Workflow runtime, which only
 * eve's bundler resolves; tests get a stand-in (tests/stubs/workflow-api.ts).
 */
export default defineConfig({
  resolve: {
    alias: { "workflow/api": fileURLToPath(new URL("./tests/stubs/workflow-api.ts", import.meta.url)) },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    unstubEnvs: true,
    unstubGlobals: true,
  },
});
