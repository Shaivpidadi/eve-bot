/**
 * Built-in connectors: services a team adds by name instead of by pasting an
 * MCP address. Each entry is the address, the kind of key it takes, where to
 * get one, and how careful a Bot must be with it. Pure data, shared by the
 * agent (to connect) and the console (to offer), so nothing here may import
 * Node built-ins.
 */

/** How a connector proves who is calling: nothing, a pasted key, or OAuth the server runs itself (one click, no setup). */
export type ConnectorKeyKind = "none" | "bearer" | "header" | "oauth";

/** When a person is asked before a Bot uses a connector's tools. */
export type ConnectorGate = "none" | "writes" | "all";

export interface CatalogEntry {
  readonly id: string;
  readonly label: string;
  /** For the model: what the service is for, the main signal eve__search uses. */
  readonly description: string;
  /** For a person: one line under the name. */
  readonly detail: string;
  readonly url: string;
  readonly key: { readonly kind: ConnectorKeyKind; readonly header?: string };
  /** How to get the key, when one is needed. */
  readonly keyHelp?: string;
  readonly keyUrl?: string;
  readonly gate: ConnectorGate;
  /**
   * Tools of this server the maintainers checked only read, by bare name.
   * They count as reviewed reads (HQ may use them) without anyone clicking,
   * because the address is fixed by the catalog. A name the server does not
   * list is harmless here; an operator's own decision always wins.
   */
  readonly reads?: readonly string[];
}

export const CATALOG: readonly CatalogEntry[] = [
  {
    id: "github",
    label: "GitHub",
    description:
      "GitHub: repositories, issues, pull requests, code search, commits, branches, releases, and Actions for the accounts the token can see.",
    detail: "Issues, pull requests, code, and Actions",
    url: "https://api.githubcopilot.com/mcp/",
    key: { kind: "bearer" },
    keyHelp: "A personal access token. Fine-grained tokens work; give it only the repositories and permissions the team needs.",
    keyUrl: "https://github.com/settings/personal-access-tokens/new",
    gate: "writes",
    reads: [
      "get_me",
      "get_issue",
      "get_issue_comments",
      "list_issues",
      "search_issues",
      "get_pull_request",
      "get_pull_request_files",
      "get_pull_request_status",
      "get_pull_request_comments",
      "get_pull_request_reviews",
      "list_pull_requests",
      "search_pull_requests",
      "search_code",
      "search_repositories",
      "get_file_contents",
      "list_commits",
      "get_commit",
      "list_branches",
      "list_tags",
      "list_releases",
      "get_latest_release",
    ],
  },
  {
    id: "linear",
    label: "Linear",
    description: "Linear: issues, projects, cycles, comments, and teams in the workspace you sign in to.",
    detail: "Issues, projects, and cycles",
    url: "https://mcp.linear.app/mcp",
    key: { kind: "oauth" },
    gate: "writes",
  },
  {
    id: "notion",
    label: "Notion",
    description: "Notion: pages, databases, and comments in the workspace you sign in to; search and read, create and update.",
    detail: "Pages and databases",
    url: "https://mcp.notion.com/mcp",
    key: { kind: "oauth" },
    gate: "writes",
  },
  {
    id: "atlassian",
    label: "Atlassian",
    description: "Jira and Confluence: issues, boards, sprints, pages, and spaces in the site you sign in to.",
    detail: "Jira issues and Confluence pages",
    url: "https://mcp.atlassian.com/v1/mcp",
    key: { kind: "oauth" },
    gate: "writes",
  },
  {
    id: "sentry",
    label: "Sentry",
    description: "Sentry: issues, events, releases, and projects in the organization you sign in to.",
    detail: "Errors, issues, and releases",
    url: "https://mcp.sentry.dev/mcp",
    key: { kind: "oauth" },
    gate: "writes",
  },
  {
    id: "deepwiki",
    label: "DeepWiki",
    description: "Answers questions about public GitHub repositories from their generated documentation.",
    detail: "Documentation for any public repository",
    url: "https://mcp.deepwiki.com/mcp",
    key: { kind: "none" },
    gate: "none",
    reads: ["read_wiki_structure", "read_wiki_contents", "ask_question"],
  },
  {
    id: "context7",
    label: "Context7",
    description: "Up-to-date documentation and code examples for libraries and frameworks, by library name.",
    detail: "Current docs for libraries and frameworks",
    url: "https://mcp.context7.com/mcp",
    key: { kind: "none" },
    gate: "none",
    reads: ["resolve-library-id", "get-library-docs", "query-docs"],
  },
];

export const catalogEntry = (id: string): CatalogEntry | undefined => CATALOG.find((entry) => entry.id === id);

/**
 * A tool that changes something, by its name. MCP servers name their tools
 * with a verb first, so the verb is a strong hint. Broad on purpose: asking
 * once too often beats a Bot merging a pull request nobody approved.
 */
const WRITE_VERB =
  /^(create|update|delete|remove|merge|push|add|set|send|post|write|edit|assign|unassign|close|reopen|submit|request|dismiss|fork|star|unstar|transfer|move|archive|unarchive|publish|upload|invite|resolve|mark|comment|reply|dispatch|run|rerun|cancel|approve|reject|lock|unlock|pin|unpin|patch|put|insert|append|modify|rename|revert|deploy|trigger|enable|disable|grant|revoke|label|unlabel|convert)(?=_|[A-Z]|$)/;

/**
 * A tool that only looks, by the verb its name starts with. Deliberately
 * short: a verb missing here costs an approval prompt, a verb wrongly here
 * costs an action nobody approved.
 */
const READ_VERB = /^(get|list|search|read|fetch|describe|find|lookup|show|view|retrieve|count)(?=[_-]|[A-Z]|$)/;

/**
 * Words that make a tool a general-purpose door rather than one narrow read:
 * a SQL or GraphQL runner, a raw HTTP or RPC request, a shell, a script. Such
 * a tool can do anything its input says, so whatever verb its name starts
 * with ("get_query_result", "fetch_url"), it counts as a change.
 */
const GENERIC_WORD =
  /^(sql|query|queries|graphql|gql|http|https|url|curl|request|requests|rpc|invoke|call|raw|api|webhook|shell|bash|sh|terminal|exec|execute|run|command|cmd|script|eval|code_exec)$/;

/** The words of a tool name, lowercased: `get_SQL-result` and `getSqlResult` both read as get, sql, result. */
const words = (name: string): string[] =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== "");

const bareName = (toolName: string): string => toolName.split("__").pop() ?? toolName;

/** Whether a connector tool, by its bare name, changes something rather than reads. */
export const isWriteTool = (toolName: string): boolean => classifyTool(toolName) === "write";

/** What a connector's tool does, as this workspace has it recorded. */
export type ToolEffect = "read" | "write";
export type ToolPolicy = Readonly<Record<string, ToolEffect>>;

/**
 * The guess at what one tool does, from its name alone.
 *
 * Read only when the name starts with a known read verb, has no write verb,
 * and names nothing general-purpose; everything else, including every name
 * nobody anticipated, is a write. A server's own annotations (`readOnlyHint`)
 * are the server describing itself and are never enough on their own; at most
 * they are a hint for the operator, who decides.
 */
export function classifyTool(toolName: string): ToolEffect {
  const bare = bareName(toolName);
  if (WRITE_VERB.test(bare) || !READ_VERB.test(bare)) return "write";
  // "Pull request" and "merge request" are things, not a raw request.
  const named = words(bare).join("_").replace(/(pull|merge)_requests?/g, "$1");
  return named.split("_").some((word) => GENERIC_WORD.test(word)) ? "write" : "read";
}

/**
 * The first guess at what each of a server's tools does, made when the
 * connector is added and recorded.
 *
 * The verb in a tool's name is a guess, and a guess is the wrong thing to
 * consult at the moment a bot is about to act: it can change under you when a
 * regex is edited, and it cannot be corrected when it is wrong. Recording the
 * answer per tool makes it a decision the operator owns, that a person can see
 * and change, and that is the same on every call. A guess stays a guess,
 * though: see `toolEffect` for how it is weighed against a reviewed decision.
 */
export function classifyTools(tools: readonly string[]): Record<string, ToolEffect> {
  const policy: Record<string, ToolEffect> = {};
  for (const tool of tools) policy[tool] = classifyTool(tool);
  return policy;
}

/**
 * The raw recorded answer for a tool, for code that only has the policy map.
 *
 * A tool nobody classified — one the server grew since it was connected — is
 * treated as changing something. The cost of that is one approval prompt; the
 * cost of the other default is a bot doing something irreversible because a
 * name was unfamiliar. Code that has the whole connector uses `toolEffect`.
 */
export function effectOf(policy: ToolPolicy | undefined, toolName: string): ToolEffect {
  return policy?.[toolName] ?? policy?.[bareName(toolName)] ?? "write";
}

/** What `toolEffect` needs of a connector. */
export interface PolicySource {
  readonly policy?: ToolPolicy;
  /** Tools whose entry in `policy` a person set; everything else there is a guess. */
  readonly reviewed?: readonly string[];
  /** The catalog entry, whose `reads` count as reviewed. */
  readonly catalog?: string | null;
}

/**
 * What a tool does, and whether a person stands behind that answer.
 *
 * - An operator's decision (the tool is in `reviewed`) is final either way.
 * - A read the catalog's maintainers checked is a reviewed read.
 * - Anything else is a guess, and a guess only reads when both the recorded
 *   entry and today's classifier say so. That keeps a stored "read" written
 *   by an older, looser classifier (one that called every unfamiliar name a
 *   read) from waving a write through, and never turns a recorded write into
 *   a read.
 *
 * HQ only ever uses reviewed reads; a Bot's writes gate asks before anything
 * whose effect is "write".
 */
export function toolEffect(source: PolicySource, toolName: string): { readonly effect: ToolEffect; readonly reviewed: boolean } {
  const bare = bareName(toolName);
  const recorded = source.policy?.[bare] ?? source.policy?.[toolName];
  if (recorded !== undefined && (source.reviewed ?? []).includes(bare)) return { effect: recorded, reviewed: true };
  const entry = source.catalog ? catalogEntry(source.catalog) : undefined;
  if (entry?.reads?.includes(bare)) return { effect: "read", reviewed: true };
  return { effect: recorded === "read" && classifyTool(bare) === "read" ? "read" : "write", reviewed: false };
}

/** A tool HQ may call: a read a person (or the catalog) stands behind. */
export const isReviewedRead = (source: PolicySource, toolName: string): boolean => {
  const { effect, reviewed } = toolEffect(source, toolName);
  return reviewed && effect === "read";
};

/**
 * The tools Bots treat as reads on a guess and HQ is not offered until a
 * person confirms them: listed by the server at the last check, switched on,
 * guessed to read, and neither reviewed nor vouched for by the catalog. The
 * "N tools need your confirmation" count on the Connectors page, and the only
 * tools a bulk confirmation may mark reviewed, so it can never turn a write
 * (recorded or guessed) into a read.
 */
export function guessedReads(
  source: PolicySource & { readonly check: { readonly tools: readonly string[] }; readonly disabledTools?: readonly string[] },
): string[] {
  const off = new Set(source.disabledTools ?? []);
  return source.check.tools.filter((tool) => {
    if (off.has(tool)) return false;
    const { effect, reviewed } = toolEffect(source, tool);
    return effect === "read" && !reviewed;
  });
}

/**
 * Keeps what the operator decided, classifies what is new, forgets what is gone.
 *
 * An unreviewed entry is only kept when it is a write; an unreviewed read is
 * guessed again, so a read recorded by an older classifier does not outlive
 * the classifier that made it.
 */
export function mergePolicy(existing: ToolPolicy | undefined, tools: readonly string[], reviewed: readonly string[] = []): Record<string, ToolEffect> {
  const merged = classifyTools(tools);
  if (existing === undefined) return merged;
  for (const tool of tools) {
    const kept = existing[tool];
    if (kept === "write" || (kept === "read" && reviewed.includes(tool))) merged[tool] = kept;
  }
  return merged;
}
