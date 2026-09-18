/**
 * Built-in connectors: services a team adds by name instead of by pasting an
 * MCP address. Each entry is the address, the kind of key it takes, where to
 * get one, and how careful a Bot must be with it. Pure data, shared by the
 * agent (to connect) and the console (to offer), so nothing here may import
 * Node built-ins.
 */

export type ConnectorKeyKind = "none" | "bearer" | "header";

/** When a person is asked before a Bot uses a connector's tools. */
export type ConnectorGate = "none" | "writes" | "all";

export interface CatalogEntry {
  readonly id: string;
  readonly label: string;
  /** For the model: what the service is for, the main signal connection_search uses. */
  readonly description: string;
  /** For a person: one line under the name. */
  readonly detail: string;
  readonly url: string;
  readonly key: { readonly kind: ConnectorKeyKind; readonly header?: string };
  /** How to get the key, when one is needed. */
  readonly keyHelp?: string;
  readonly keyUrl?: string;
  readonly gate: ConnectorGate;
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
  },
  {
    id: "deepwiki",
    label: "DeepWiki",
    description: "Answers questions about public GitHub repositories from their generated documentation.",
    detail: "Documentation for any public repository",
    url: "https://mcp.deepwiki.com/mcp",
    key: { kind: "none" },
    gate: "none",
  },
  {
    id: "context7",
    label: "Context7",
    description: "Up-to-date documentation and code examples for libraries and frameworks, by library name.",
    detail: "Current docs for libraries and frameworks",
    url: "https://mcp.context7.com/mcp",
    key: { kind: "none" },
    gate: "none",
  },
];

export const catalogEntry = (id: string): CatalogEntry | undefined => CATALOG.find((entry) => entry.id === id);

/**
 * A tool that changes something, by its name. MCP servers name their tools
 * with a verb first, so the verb decides; anything not on this list reads.
 * Broad on purpose: asking once too often beats a Bot merging a pull request
 * nobody approved.
 */
const WRITE_VERB =
  /^(create|update|delete|remove|merge|push|add|set|send|post|write|edit|assign|unassign|close|reopen|submit|request|dismiss|fork|star|unstar|transfer|move|archive|unarchive|publish|upload|invite|resolve|mark|comment|reply|dispatch|run|rerun|cancel|approve|reject|lock|unlock|pin|unpin|patch|put|insert|append|modify|rename|revert|deploy|trigger|enable|disable|grant|revoke|label|unlabel|convert)(?=_|[A-Z]|$)/;

/** Whether a connector tool, by its bare name, changes something rather than reads. */
export const isWriteTool = (toolName: string): boolean => WRITE_VERB.test(toolName.split("__").pop() ?? toolName);
