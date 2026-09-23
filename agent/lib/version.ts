import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Which EVE Bot this is, and whether the original has moved on.
 *
 * A deployment made with the Vercel button is a copy of the repository, so it
 * does not learn about new releases on its own. The console asks here, this
 * asks GitHub for the original's `package.json` at most every six hours, and
 * a newer version shows as a note in the sidebar with the way to update.
 */
export interface Version {
  readonly version: string;
  /** The deployed commit, when Vercel says. */
  readonly commit: string | null;
  /** The original's current version, or null when GitHub could not be asked. */
  readonly latest: string | null;
  readonly updateAvailable: boolean;
  /** Where "Update now" goes: the copy's own sync workflow when Vercel built this from a copy, else the notes. */
  readonly howToUpdate: string;
  /** True when that link runs the update itself rather than explaining it. */
  readonly runsItself: boolean;
}

const ORIGINAL = "shaivpidadi/eve-bot";

/** The repository Vercel built this deployment from, when it says. */
export function builtFrom(env: NodeJS.ProcessEnv = process.env): { readonly owner: string; readonly slug: string } | null {
  const owner = env.VERCEL_GIT_REPO_OWNER?.trim();
  const slug = env.VERCEL_GIT_REPO_SLUG?.trim();
  if (!owner || !slug || (env.VERCEL_GIT_PROVIDER ?? "github").toLowerCase() !== "github") return null;
  return { owner, slug };
}

/**
 * A copy has the sync workflow; opening it with "Run workflow" is the update.
 * The original, and a deployment Vercel did not build from git, get the notes.
 */
export function updateLink(env: NodeJS.ProcessEnv = process.env): { readonly url: string; readonly runsItself: boolean } {
  const repo = builtFrom(env);
  if (repo === null || `${repo.owner}/${repo.slug}`.toLowerCase() === ORIGINAL) return { url: HOW_TO_UPDATE, runsItself: false };
  return { url: `https://github.com/${repo.owner}/${repo.slug}/actions/workflows/sync-upstream.yml`, runsItself: true };
}

const UPSTREAM_PACKAGE = "https://raw.githubusercontent.com/Shaivpidadi/eve-bot/main/package.json";
const HOW_TO_UPDATE = "https://github.com/Shaivpidadi/eve-bot#keeping-it-up-to-date";
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

let own: string | undefined;
let upstream: { readonly latest: string | null; readonly until: number } | undefined;

/** This build's version: the package's, or `BOT_VERSION` where the package file is not shipped. */
export function ownVersion(): string {
  if (own !== undefined) return own;
  const fromEnv = process.env.BOT_VERSION?.trim();
  if (fromEnv) return (own = fromEnv);
  try {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { version?: unknown };
    own = typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    own = "0.0.0";
  }
  return own;
}

/** `a` is newer than `b`, comparing dot-separated numbers; anything unparseable is 0. */
export function newer(a: string, b: string): boolean {
  const parts = (value: string) => value.replace(/^v/, "").split(/[.+-]/).map((part) => (Number.isFinite(Number(part)) ? Number(part) : 0));
  const left = parts(a);
  const right = parts(b);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const l = left[index] ?? 0;
    const r = right[index] ?? 0;
    if (l !== r) return l > r;
  }
  return false;
}

async function latestVersion(fetcher: typeof fetch): Promise<string | null> {
  if (upstream !== undefined && upstream.until > Date.now()) return upstream.latest;
  let latest: string | null = null;
  try {
    const response = await fetcher(UPSTREAM_PACKAGE, { signal: AbortSignal.timeout(4_000), headers: { accept: "application/json" } });
    const pkg: unknown = response.ok ? await response.json() : null;
    const version = typeof pkg === "object" && pkg !== null ? (pkg as { version?: unknown }).version : undefined;
    if (typeof version === "string") latest = version;
  } catch {
    // Offline, or GitHub is slow: the console just does not mention updates.
  }
  upstream = { latest, until: Date.now() + CHECK_EVERY_MS };
  return latest;
}

export async function versionReport(fetcher: typeof fetch = fetch): Promise<Version> {
  const version = ownVersion();
  const latest = process.env.BOT_UPDATE_CHECK === "off" ? null : await latestVersion(fetcher);
  const link = updateLink();
  return {
    version,
    commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
    latest,
    updateAvailable: latest !== null && newer(latest, version),
    howToUpdate: link.url,
    runsItself: link.runsItself,
  };
}

/** For tests. */
export function forgetVersion(): void {
  own = undefined;
  upstream = undefined;
}
