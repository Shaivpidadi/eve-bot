import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

/**
 * Which build of the code this process runs.
 *
 * A job's lease names the build that holds it (see `JobLease.build`), so a
 * local deployment can tell a run that is merely quiet from one whose
 * process was replaced by new code: eve's local Workflow world cannot resume
 * a run across a code change, so such a lease is dead the moment the new
 * build starts. The id must be the same across restarts of the same code
 * (those runs do resume) and different for different code.
 *
 * - On Vercel, the deployment id.
 * - Under `eve dev`, the current development generation, which eve records in
 *   `.eve/dev-runtime/current.json` and replaces whenever the agent is rebuilt.
 * - Under a built server (`NODE_ENV=production`, as `npm start` runs it), the
 *   build's date from `.output/nitro.json`. A dev pointer left by an earlier
 *   `npm run dev` says nothing about the build being served, so it is ignored.
 * - `BOT_BUILD_ID` overrides all of them; `unknown` when nothing can be read.
 */
export const UNKNOWN_BUILD = "unknown";

export interface BuildSource {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
}

let cached: string | undefined;

/**
 * The QA override lives on the process, not in this module: eve bundles the
 * workflow steps apart from the routes, so each bundle has its own copy of
 * this module and its own cache, and all of them must report the new id.
 */
const OVERRIDE = Symbol.for("bot.build.override");
const shared = globalThis as typeof globalThis & { [OVERRIDE]?: string };

export function buildId(source: BuildSource = {}): string {
  if (source.env === undefined && source.cwd === undefined) {
    const forced = shared[OVERRIDE];
    if (forced !== undefined) return forced;
    if (cached !== undefined) return cached;
  }
  const id = resolve(source.env ?? process.env, source.cwd ?? process.cwd());
  if (source.env === undefined && source.cwd === undefined) cached = id;
  return id;
}

function resolve(env: Readonly<Record<string, string | undefined>>, cwd: string): string {
  const forced = env.BOT_BUILD_ID?.trim();
  if (forced) return forced;
  const deployment = env.VERCEL_DEPLOYMENT_ID?.trim();
  if (deployment) return `vercel:${deployment}`;
  const generation = env.NODE_ENV === "production" ? null : devGeneration(cwd);
  if (generation !== null) return `dev:${generation}`;
  const built = buildDate(cwd);
  if (built !== null) return `build:${built}`;
  return UNKNOWN_BUILD;
}

function devGeneration(cwd: string): string | null {
  const pointer = join(cwd, ".eve", "dev-runtime", "current.json");
  if (!existsSync(pointer)) return null;
  try {
    const parsed = JSON.parse(readFileSync(pointer, "utf8")) as { snapshotRoot?: unknown };
    return typeof parsed.snapshotRoot === "string" && parsed.snapshotRoot !== "" ? basename(parsed.snapshotRoot) : null;
  } catch {
    return null;
  }
}

function buildDate(cwd: string): string | null {
  const manifest = join(cwd, ".output", "nitro.json");
  if (!existsSync(manifest)) return null;
  try {
    const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { date?: unknown };
    return typeof parsed.date === "string" && parsed.date !== "" ? parsed.date : null;
  } catch {
    return null;
  }
}

/** For tests: forget the cached id and any override. */
export function resetBuildId(): void {
  cached = undefined;
  delete shared[OVERRIDE];
}

/** For the QA suite: this process now reports `id`, as if it were new code. */
export function overrideBuildId(id: string): void {
  shared[OVERRIDE] = id;
}
