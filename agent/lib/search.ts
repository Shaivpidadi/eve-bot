/**
 * Web search for Bots on your own model endpoint.
 *
 * eve's built-in `web_search` is provider-managed: AI Gateway runs it through
 * Exa or Parallel, and direct Anthropic, OpenAI, and Google models bring their
 * own. An OpenAI-compatible endpoint has none, so `agent/tools/web_search.ts`
 * swaps in this implementation there. It asks whichever search service
 * `BOT_SEARCH_PROVIDER` names and hands back the same shape every time: a
 * title, a URL, and a snippet per result.
 *
 * - `searxng`: a SearXNG instance at `BOT_SEARCH_URL`, with JSON output enabled
 *   in its settings. Nothing leaves your network; `docker-compose.yml` runs one.
 * - `brave`, `tavily`, `exa`: hosted APIs, with `BOT_SEARCH_API_KEY`.
 *
 * Search results are untrusted text from the web, like a page a Bot reads.
 */

export const SEARCH_PROVIDERS = ["searxng", "brave", "tavily", "exa"] as const;
export type SearchProvider = (typeof SEARCH_PROVIDERS)[number];

export interface SearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  readonly publishedAt?: string;
}

export interface SearchConfig {
  readonly provider: SearchProvider;
  readonly url: string;
  readonly apiKey: string | undefined;
}

const TIMEOUT_MS = 20_000;
export const MAX_RESULTS = 10;
const SNIPPET_CHARS = 600;

const HOSTED_URLS: Readonly<Record<Exclude<SearchProvider, "searxng">, string>> = {
  brave: "https://api.search.brave.com/res/v1/web/search",
  tavily: "https://api.tavily.com/search",
  exa: "https://api.exa.ai/search",
};

const isProvider = (value: string): value is SearchProvider => (SEARCH_PROVIDERS as readonly string[]).includes(value);

/**
 * How search is configured, or null when it is not. `BOT_SEARCH_URL` alone
 * means a SearXNG instance; a hosted provider needs its key.
 */
export function searchConfig(env: NodeJS.ProcessEnv = process.env): SearchConfig | null {
  const named = env.BOT_SEARCH_PROVIDER?.trim().toLowerCase() ?? "";
  const url = env.BOT_SEARCH_URL?.trim().replace(/\/+$/, "") ?? "";
  const apiKey = env.BOT_SEARCH_API_KEY?.trim() || undefined;
  if (named !== "" && !isProvider(named)) {
    console.warn(`[bot] BOT_SEARCH_PROVIDER=${named} is not one of ${SEARCH_PROVIDERS.join(", ")}; web search is off.`);
    return null;
  }
  const provider: SearchProvider | null = named !== "" ? named : url !== "" ? "searxng" : null;
  if (provider === null) return null;
  if (provider === "searxng") {
    if (url === "") {
      console.warn("[bot] BOT_SEARCH_PROVIDER=searxng needs BOT_SEARCH_URL; web search is off.");
      return null;
    }
    return { provider, url, apiKey };
  }
  if (apiKey === undefined) {
    console.warn(`[bot] BOT_SEARCH_PROVIDER=${provider} needs BOT_SEARCH_API_KEY; web search is off.`);
    return null;
  }
  // A hosted provider has one address; BOT_SEARCH_URL only ever names a SearXNG.
  return { provider, url: HOSTED_URLS[provider], apiKey };
}

export class SearchError extends Error {}

async function call(input: string, init: RequestInit, provider: SearchProvider): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(input, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    throw new SearchError(`${provider} did not answer: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 200);
    throw new SearchError(`${provider} answered ${response.status}${detail ? `: ${detail}` : ""}`);
  }
  return response.json();
}

const text = (value: unknown): string => (typeof value === "string" ? value : "").replace(/\s+/g, " ").trim();
const clip = (value: string) => (value.length > SNIPPET_CHARS ? `${value.slice(0, SNIPPET_CHARS - 1)}…` : value);

function results(rows: unknown, pick: (row: Record<string, unknown>) => SearchResult | null, limit: number): SearchResult[] {
  if (!Array.isArray(rows)) return [];
  const out: SearchResult[] = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const result = pick(row as Record<string, unknown>);
    if (result === null || !/^https?:\/\//i.test(result.url)) continue;
    out.push({ ...result, snippet: clip(result.snippet) });
    if (out.length >= limit) break;
  }
  return out;
}

export async function search(config: SearchConfig, query: string, limit = 5): Promise<SearchResult[]> {
  const count = Math.min(Math.max(1, Math.trunc(limit)), MAX_RESULTS);
  switch (config.provider) {
    case "searxng": {
      const params = new URLSearchParams({ q: query, format: "json", safesearch: "1" });
      const body = (await call(`${config.url}/search?${params}`, { headers: { accept: "application/json" } }, "searxng")) as {
        results?: unknown;
      };
      return results(
        body.results,
        (row) => ({ title: text(row.title), url: text(row.url), snippet: text(row.content), ...(row.publishedDate ? { publishedAt: text(row.publishedDate) } : {}) }),
        count,
      );
    }
    case "brave": {
      const params = new URLSearchParams({ q: query, count: String(count), safesearch: "moderate", text_decorations: "0" });
      const body = (await call(
        `${config.url}?${params}`,
        { headers: { accept: "application/json", "x-subscription-token": config.apiKey ?? "" } },
        "brave",
      )) as { web?: { results?: unknown } };
      return results(
        body.web?.results,
        (row) => ({ title: text(row.title), url: text(row.url), snippet: text(row.description), ...(row.age ? { publishedAt: text(row.age) } : {}) }),
        count,
      );
    }
    case "tavily": {
      const body = (await call(
        config.url,
        {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey ?? ""}` },
          body: JSON.stringify({ query, max_results: count, search_depth: "basic" }),
        },
        "tavily",
      )) as { results?: unknown };
      return results(
        body.results,
        (row) => ({ title: text(row.title), url: text(row.url), snippet: text(row.content), ...(row.published_date ? { publishedAt: text(row.published_date) } : {}) }),
        count,
      );
    }
    case "exa": {
      const body = (await call(
        config.url,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": config.apiKey ?? "" },
          body: JSON.stringify({ query, numResults: count, type: "auto", contents: { highlights: { maxCharacters: SNIPPET_CHARS, numSentences: 3 } } }),
        },
        "exa",
      )) as { results?: unknown };
      return results(
        body.results,
        (row) => ({
          title: text(row.title),
          url: text(row.url),
          snippet: Array.isArray(row.highlights) ? row.highlights.map(text).join(" ") : text(row.text),
          ...(row.publishedDate ? { publishedAt: text(row.publishedDate) } : {}),
        }),
        count,
      );
    }
  }
}
