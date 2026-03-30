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

/**
 * Search a specific domain for articles matching `query`.
 * `domain` accepts a bare hostname ("thestar.com.my") or a URL
 * ("https://thestar.com.my") — the hostname is extracted automatically.
 */
export async function crawlDomain(
  domain: string,
  query: string,
  options: { maxResults?: number; days?: number } = {}
): Promise<TavilyResult[]> {
  const { maxResults = 15, days = 30 } = options;

  // Normalise to bare hostname
  let hostname = domain.trim();
  try {
    if (hostname.includes("://")) {
      hostname = new URL(hostname).hostname;
    } else {
      hostname = new URL(`https://${hostname}`).hostname;
    }
  } catch {
    // leave as-is if URL parsing fails
  }

  logger.info({ hostname, query }, "Tavily domain crawl");

  try {
    const client = getClient();
    const response = await client.search(query, {
      searchDepth: "advanced",
      includeRawContent: true,
      maxResults,
      days,
      topic: "news",
      includeDomains: [hostname],
    });

    return response.results.map((r) => ({
      url: r.url,
      title: r.title ?? "",
      content: r.rawContent ?? r.content ?? "",
      publishedDate: r.publishedDate,
      score: r.score ?? 0,
    }));
  } catch (err) {
    logger.error({ err, hostname, query }, "Tavily domain crawl failed");
    return [];
  }
}
