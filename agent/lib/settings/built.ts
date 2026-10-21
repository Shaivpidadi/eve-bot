/**
 * The Settings values `eve build` fixes (spend caps, where the computer runs,
 * the engines), for a deployment's running server. Locally, `scripts/start.mjs`
 * lays them over the environment the server starts with; a Vercel function has
 * no such start, and its environment never saw what the build was given. So
 * `scripts/build.mjs` writes them here before the build, and this module lays
 * them over `process.env` when it loads, before anything that reads them.
 *
 * Empty in git, and put back empty after each build: a build from the
 * environment alone changes nothing. Import it first, for its effect, in any
 * module that reads one of these variables when it loads.
 */
const BUILT: Readonly<Record<string, string>> = {};

// What each variable held before, for the Settings page (the start script records the same).
const was: Record<string, string | null> = {};
for (const [name, value] of Object.entries(BUILT)) {
  was[name] = process.env[name] ?? null;
  process.env[name] = value;
}
if (Object.keys(was).length > 0 && process.env.BOT_SETTINGS_OVERLAY === undefined) process.env.BOT_SETTINGS_OVERLAY = JSON.stringify(was);

/** The values this build was given from Settings. */
export const BUILT_SETTINGS = BUILT;
