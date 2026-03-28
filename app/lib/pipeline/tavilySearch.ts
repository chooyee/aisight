import { tavily } from "@tavily/core";
import { logger } from "../logger.js";

export interface TavilyResult {
  url: string;
  title: string;
  content: string; // raw_content when available, snippet otherwise
  publishedDate?: string;
  score: number;
}

let _client: ReturnType<typeof tavily> | undefined;

function getClient() {
  if (!_client) {
    const apiKey = process.env.TAVILY_API_KEY;
    if (!apiKey) throw new Error("TAVILY_API_KEY is not set");
    _client = tavily({ apiKey });
  }
  return _client;
}

export async function searchNews(
  query: string,
  options: { maxResults?: number; days?: number } = {}
): Promise<TavilyResult[]> {
  const { maxResults = 10, days = 7 } = options;

  try {
    const client = getClient();
    const response = await client.search(query, {
      searchDepth: "advanced",
      includeRawContent: true,
      maxResults,
      days,
      topic: "news",
    });

    return response.results.map((r) => ({
      url: r.url,
      title: r.title ?? "",
      content: r.rawContent ?? r.content ?? "",
      publishedDate: r.publishedDate,
      score: r.score ?? 0,
    }));
  } catch (err) {
    logger.error({ err, query }, "Tavily search failed");
    return [];
  }
}
