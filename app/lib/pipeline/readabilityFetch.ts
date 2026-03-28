import { Readability } from "@mozilla/readability";
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

    // Readability needs a real DOM — use node-html-parser shim
    const root = parseHtml(html);

    // Build a minimal DOM-like object Readability can work with
    const doc = {
      title: root.querySelector("title")?.text ?? "",
      documentElement: {
        innerHTML: html,
        textContent: root.textContent,
      },
      location: { href: url },
      createElement: () => ({ innerHTML: "" }),
      createRange: () => ({
        selectNodeContents: () => {},
        setStart: () => {},
        setEnd: () => {},
      }),
      // Provide querySelector/querySelectorAll for Readability's internal use
      querySelector: (sel: string) => root.querySelector(sel) as unknown,
      querySelectorAll: (sel: string) => root.querySelectorAll(sel) as unknown,
      head: root.querySelector("head") as unknown,
      body: root.querySelector("body") as unknown,
    };

    const reader = new Readability(doc as unknown as Document);
    const article = reader.parse();

    if (!article || (article.textContent?.length ?? 0) < MIN_CONTENT_LENGTH) {
      logger.warn({ url }, "Readability returned insufficient content");
      return null;
    }

    return {
      url,
      title: article.title ?? "",
      content: article.textContent ?? "",
      publishedAt,
      method: "readability",
    };
  } catch (err) {
    logger.warn({ err, url }, "Readability fetch failed");
    return null;
  }
}
