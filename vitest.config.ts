import { defineConfig } from "vitest/config";

/**
 * Tests live in `tests/`, never under `agent/`: eve treats every module there
 * as part of the agent, and a test file next to a tool would be loaded as one.
 * Nothing here needs Vercel credentials, Docker, or a model; everything the
 * standalone server relies on is exercised in-process.
 */
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    unstubEnvs: true,
    unstubGlobals: true,
  },
});
