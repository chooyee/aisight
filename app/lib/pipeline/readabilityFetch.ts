import { parse as parseHtml } from "node-html-parser";
import { logger } from "../logger.js";
import { respectRateLimit } from "./rateLimit.js";

export interface FetchedArticle {
  url: string;
  title: string;
  content: string;
  publishedAt?: Date;
  method: "readability";
}

const MIN_CONTENT_LENGTH = 100;

// Extract publish date from common HTML meta tags
function extractPublishedDate(html: string): Date | undefined {
  const root = parseHtml(html);

  const selectors = [
    'meta[property="article:published_time"]',
    'meta[name="pubdate"]',
    'meta[name="publishdate"]',
    'meta[itemprop="datePublished"]',
    'time[datetime]',
  ];

  for (const sel of selectors) {
    const el = root.querySelector(sel);
    const val = el?.getAttribute("content") ?? el?.getAttribute("datetime");
    if (val) {
      const d = new Date(val);
      if (!isNaN(d.getTime())) return d;
    }
  }
  return undefined;
}

// Extract main article text using node-html-parser.
// Removes boilerplate containers then collects paragraph text.
function extractArticleText(html: string): { title: string; content: string } {
  const root = parseHtml(html);

  // Remove noise elements
  for (const sel of ["script", "style", "nav", "header", "footer", "aside", "noscript", "iframe", "form"]) {
    for (const el of root.querySelectorAll(sel)) {
      el.remove();
    }
  }

  const title = root.querySelector("title")?.text?.trim() ?? "";

  // Try known article containers first, fall back to body
  const containers = [
    'article',
    '[role="main"]',
    'main',
    '.article-content',
    '.post-content',
    '.entry-content',
    '#content',
    '#main',
    'body',
  ];

  let articleEl = root.querySelector("body") ?? root;
  for (const sel of containers) {
    const el = root.querySelector(sel);
    if (el) {
      articleEl = el;
      break;
    }
  }

  // Collect paragraph and heading text
  const textParts: string[] = [];
  for (const el of articleEl.querySelectorAll("p, h1, h2, h3, h4, li")) {
    const text = el.text.trim();
    if (text.length > 20) textParts.push(text);
  }

  const content = textParts.join("\n\n");
  return { title, content };
}

export async function fetchWithReadability(url: string): Promise<FetchedArticle | null> {
  await respectRateLimit(url);

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; AISightBot/1.0; +https://localhost)",
        Accept: "text/html,application/xhtml+xml",
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      logger.warn({ url, status: res.status }, "HTTP fetch failed");
      return null;
    }

    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html")) {
      logger.warn({ url, contentType }, "Non-HTML content type, skipping");
      return null;
    }

    const html = await res.text();
    const publishedAt = extractPublishedDate(html);
    const { title, content } = extractArticleText(html);

    if (content.length < MIN_CONTENT_LENGTH) {
      logger.warn({ url }, "Extracted insufficient content");
      return null;
    }

    return {
      url,
      title,
      content,
      publishedAt,
      method: "readability",
    };
  } catch (err) {
    logger.warn({ err, url }, "Readability fetch failed");
    return null;
  }
}
