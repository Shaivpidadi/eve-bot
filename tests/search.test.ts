import { beforeEach, describe, expect, it, vi } from "vitest";

import { MAX_RESULTS, search, searchConfig, SearchError } from "../agent/lib/search";

/** The last request the stubbed fetch saw. */
function stubFetch(body: unknown, status = 200) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return status === 200 ? Response.json(body) : new Response(String(body), { status });
    }),
  );
  return calls;
}

describe("searchConfig", () => {
  beforeEach(() => vi.spyOn(console, "warn").mockImplementation(() => undefined));

  it("is off with nothing set, and says why when half set", () => {
    expect(searchConfig({})).toBeNull();
    expect(searchConfig({ BOT_SEARCH_PROVIDER: "bing" })).toBeNull();
    expect(searchConfig({ BOT_SEARCH_PROVIDER: "searxng" })).toBeNull();
    expect(searchConfig({ BOT_SEARCH_PROVIDER: "brave" })).toBeNull();
    expect(console.warn).toHaveBeenCalledTimes(3);
  });

  it("takes a URL alone as a SearXNG, and a hosted provider with its key", () => {
    expect(searchConfig({ BOT_SEARCH_URL: "http://searxng:8080/" })).toEqual({ provider: "searxng", url: "http://searxng:8080", apiKey: undefined });
    expect(searchConfig({ BOT_SEARCH_PROVIDER: "Tavily", BOT_SEARCH_API_KEY: "k" })).toEqual({
      provider: "tavily",
      url: "https://api.tavily.com/search",
      apiKey: "k",
    });
    // A SearXNG URL left over in the environment does not redirect a hosted provider.
    expect(searchConfig({ BOT_SEARCH_PROVIDER: "brave", BOT_SEARCH_API_KEY: "k", BOT_SEARCH_URL: "http://searxng:8080" })?.url).toBe(
      "https://api.search.brave.com/res/v1/web/search",
    );
  });
});

describe("search", () => {
  it("asks SearXNG for JSON and returns title, URL, snippet, and date", async () => {
    const calls = stubFetch({
      results: [
        { title: "One", url: "https://a.example/1", content: "First  result\n text", publishedDate: "2026-01-02" },
        { title: "Not http", url: "ftp://x", content: "skip" },
        { title: "Two", url: "https://a.example/2", content: "x".repeat(700) },
        { title: "Three", url: "https://a.example/3", content: "cut by limit" },
      ],
    });
    const results = await search({ provider: "searxng", url: "http://searxng:8080", apiKey: undefined }, "eve agents", 2);
    expect(calls[0]?.url).toBe("http://searxng:8080/search?q=eve+agents&format=json&safesearch=1");
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ title: "One", url: "https://a.example/1", snippet: "First result text", publishedAt: "2026-01-02" });
    expect(results[1]?.snippet).toHaveLength(600);
    expect(results[1]?.snippet.endsWith("…")).toBe(true);
  });

  it("sends Brave its key in the header and reads web.results", async () => {
    const calls = stubFetch({ web: { results: [{ title: "B", url: "https://b.example", description: "brave", age: "2 days ago" }] } });
    const results = await search({ provider: "brave", url: "https://api.search.brave.com/res/v1/web/search", apiKey: "brave-key" }, "q", 50);
    expect(new URL(calls[0]?.url ?? "").searchParams.get("count")).toBe(String(MAX_RESULTS));
    expect((calls[0]?.init?.headers as Record<string, string>)["x-subscription-token"]).toBe("brave-key");
    expect(results).toEqual([{ title: "B", url: "https://b.example", snippet: "brave", publishedAt: "2 days ago" }]);
  });

  it("posts to Tavily and Exa with their own shapes", async () => {
    let calls = stubFetch({ results: [{ title: "T", url: "https://t.example", content: "tavily" }] });
    expect(await search({ provider: "tavily", url: "https://api.tavily.com/search", apiKey: "tk" }, "q")).toEqual([
      { title: "T", url: "https://t.example", snippet: "tavily" },
    ]);
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({ query: "q", max_results: 5 });
    expect((calls[0]?.init?.headers as Record<string, string>).authorization).toBe("Bearer tk");

    calls = stubFetch({ results: [{ title: "E", url: "https://e.example", highlights: ["one", "two"], publishedDate: "2026-05-05" }] });
    expect(await search({ provider: "exa", url: "https://api.exa.ai/search", apiKey: "ek" }, "q", 1)).toEqual([
      { title: "E", url: "https://e.example", snippet: "one two", publishedAt: "2026-05-05" },
    ]);
    expect((calls[0]?.init?.headers as Record<string, string>)["x-api-key"]).toBe("ek");
    expect(JSON.parse(String(calls[0]?.init?.body)).numResults).toBe(1);
  });

  it("turns a refusal or an unreachable service into a SearchError that names the provider", async () => {
    stubFetch("rate limited", 429);
    await expect(search({ provider: "brave", url: "https://api.search.brave.com/res/v1/web/search", apiKey: "k" }, "q")).rejects.toThrow(
      /brave answered 429: rate limited/,
    );
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("fetch failed"))));
    const error = await search({ provider: "searxng", url: "http://127.0.0.1:1", apiKey: undefined }, "q").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SearchError);
    expect((error as Error).message).toMatch(/searxng did not answer: fetch failed/);
  });
});
