/**
 * "Update now", run from the console (see docs/updating.md).
 *
 * A deployment made with the Vercel button is a copy of the repository, and
 * its own workflow, Sync with upstream, merges each new release in; Vercel
 * deploys the result. That workflow's token may change every file but the
 * workflows themselves, so given the owner's GitHub token this first brings
 * the copy's `.github/workflows` up to the release in one commit, then starts
 * the workflow, and reports how its run is going. The token is the owner's,
 * saved sealed in Settings; it never leaves this server.
 */

const API = "https://api.github.com";
const ORIGINAL = "Shaivpidadi/eve-bot";
const WORKFLOW = "sync-upstream.yml";
const WORKFLOWS_DIR = ".github/workflows";

export interface Repo {
  readonly owner: string;
  readonly slug: string;
}

export class UpdateError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "UpdateError";
  }
}

type Fetch = typeof fetch;

async function github<T>(token: string, path: string, fetcher: Fetch, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: T | null }> {
  const response = await fetcher(`${API}${path}`, {
    method: init.method ?? "GET",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  const body = text === "" ? null : (JSON.parse(text) as T);
  return { status: response.status, body };
}

/** What GitHub's refusal means for the person who pressed the button. */
function refused(repo: Repo, status: number, doing: string): UpdateError {
  if (status === 401) return new UpdateError("GitHub refused the token in Settings (Updates); it may have expired. Save a new one.", 401);
  return new UpdateError(
    `The token in Settings (Updates) cannot ${doing} on ${repo.owner}/${repo.slug}. Give it this repository, with Actions, Contents and Workflows set to read and write.`,
    status === 404 ? 404 : 403,
  );
}

async function must<T>(repo: Repo, doing: string, call: Promise<{ status: number; body: T | null }>): Promise<T> {
  const { status, body } = await call;
  if (status >= 200 && status < 300 && body !== null) return body;
  throw refused(repo, status, doing);
}

const decode = (base64: string) => Buffer.from(base64, "base64").toString("utf8");

/** The original's workflow files at a ref, by path. */
async function originalWorkflows(token: string, ref: string, fetcher: Fetch): Promise<Map<string, string>> {
  const listed = await github<{ path: string; type: string }[]>(token, `/repos/${ORIGINAL}/contents/${WORKFLOWS_DIR}?ref=${encodeURIComponent(ref)}`, fetcher);
  if (listed.status !== 200 || !Array.isArray(listed.body)) throw new UpdateError(`Could not read the original's workflows at ${ref} (GitHub said ${listed.status}).`, 502);
  const files = new Map<string, string>();
  for (const entry of listed.body.filter((item) => item.type === "file")) {
    const file = await github<{ content?: string }>(token, `/repos/${ORIGINAL}/contents/${entry.path}?ref=${encodeURIComponent(ref)}`, fetcher);
    if (file.status !== 200 || typeof file.body?.content !== "string") throw new UpdateError(`Could not read ${entry.path} from the original (GitHub said ${file.status}).`, 502);
    files.set(entry.path, decode(file.body.content));
  }
  return files;
}

/**
 * Brings the copy's workflows up to the original's at `ref`, in one commit on
 * its default branch; the names of the files that changed (none: no commit).
 * Workflows the copy added of its own are left alone.
 */
export async function updateWorkflows(token: string, repo: Repo, branch: string, ref: string, fetcher: Fetch = fetch): Promise<string[]> {
  const wanted = await originalWorkflows(token, ref, fetcher);
  const changed: { path: string; content: string }[] = [];
  for (const [path, content] of wanted) {
    const current = await github<{ content?: string }>(token, `/repos/${repo.owner}/${repo.slug}/contents/${path}?ref=${encodeURIComponent(branch)}`, fetcher);
    if (current.status === 404) changed.push({ path, content });
    else if (current.status !== 200) throw refused(repo, current.status, "read its workflows");
    else if (typeof current.body?.content !== "string" || decode(current.body.content) !== content) changed.push({ path, content });
  }
  if (changed.length === 0) return [];
  const base = `/repos/${repo.owner}/${repo.slug}/git`;
  const head = await must<{ object: { sha: string } }>(repo, "read its branch", github(token, `${base}/ref/heads/${encodeURIComponent(branch)}`, fetcher));
  const commit = await must<{ tree: { sha: string } }>(repo, "read its branch", github(token, `${base}/commits/${head.object.sha}`, fetcher));
  const tree = await must<{ sha: string }>(
    repo,
    "change its workflows",
    github(token, `${base}/trees`, fetcher, { method: "POST", body: { base_tree: commit.tree.sha, tree: changed.map(({ path, content }) => ({ path, mode: "100644", type: "blob", content })) } }),
  );
  const made = await must<{ sha: string }>(
    repo,
    "change its workflows",
    github(token, `${base}/commits`, fetcher, { method: "POST", body: { message: `chore: update workflows to eve-bot ${ref}`, tree: tree.sha, parents: [head.object.sha] } }),
  );
  await must(repo, "change its workflows", github(token, `${base}/refs/heads/${encodeURIComponent(branch)}`, fetcher, { method: "PATCH", body: { sha: made.sha } }));
  return changed.map(({ path }) => path);
}

export interface UpdateStarted {
  /** The release it updates to; null when the original has no tag for it, and the workflow takes the newest. */
  readonly tag: string | null;
  readonly workflowsUpdated: readonly string[];
  readonly at: string;
}

/** Updates the copy to the original's `version`: its workflows first, then its sync workflow does the rest. */
export async function startUpdate(token: string, repo: Repo, version: string | null, fetcher: Fetch = fetch): Promise<UpdateStarted> {
  const info = await must<{ default_branch: string }>(repo, "read the repository", github(token, `/repos/${repo.owner}/${repo.slug}`, fetcher));
  const branch = info.default_branch;
  const tag = version === null ? null : `v${version.replace(/^v/, "")}`;
  const tagged = tag !== null && (await github(token, `/repos/${ORIGINAL}/git/ref/tags/${encodeURIComponent(tag)}`, fetcher)).status === 200;
  const ref = tagged ? tag! : "main";
  const at = new Date().toISOString();
  const workflowsUpdated = await updateWorkflows(token, repo, branch, ref, fetcher);
  const dispatched = await github(token, `/repos/${repo.owner}/${repo.slug}/actions/workflows/${WORKFLOW}/dispatches`, fetcher, {
    method: "POST",
    body: { ref: branch, inputs: { target: tagged ? tag : "release" } },
  });
  if (dispatched.status !== 204) throw refused(repo, dispatched.status, "run its Sync with upstream workflow");
  return { tag: tagged ? tag : null, workflowsUpdated, at };
}

export interface UpdateRun {
  readonly status: "queued" | "in_progress" | "completed" | string;
  /** Once completed: success, failure, cancelled, … */
  readonly conclusion: string | null;
  readonly url: string;
  readonly at: string;
}

/** The latest run of the copy's sync workflow started from here or the Actions tab, or null when there is none. */
export async function latestRun(token: string, repo: Repo, fetcher: Fetch = fetch): Promise<UpdateRun | null> {
  const runs = await must<{ workflow_runs: { status: string; conclusion: string | null; html_url: string; created_at: string }[] }>(
    repo,
    "read its workflow runs",
    github(token, `/repos/${repo.owner}/${repo.slug}/actions/workflows/${WORKFLOW}/runs?event=workflow_dispatch&per_page=1`, fetcher),
  );
  const run = runs.workflow_runs[0];
  return run === undefined ? null : { status: run.status, conclusion: run.conclusion, url: run.html_url, at: run.created_at };
}
