import { chromium, type Browser } from "playwright";
import { logger } from "../logger.js";
import { respectRateLimit } from "./rateLimit.js";

export interface PlaywrightArticle {
  url: string;
  title: string;
  content: string;
  publishedAt?: Date;
  method: "playwright";
}

const MIN_CONTENT_LENGTH = 100;

// Lazily initialised singleton browser — avoids spawning Chromium per request
let _browser: Browser | undefined;

export async function getBrowser(): Promise<Browser> {
  if (!_browser || !_browser.isConnected()) {
    _browser = await chromium.launch({ headless: true });
    logger.info("Playwright Chromium launched");
  }
  return _browser;
}

export async function closeBrowser(): Promise<void> {
  if (_browser) {
    await _browser.close();
    _browser = undefined;
    logger.info("Playwright Chromium closed");
  }
}

export async function fetchWithPlaywright(url: string): Promise<PlaywrightArticle | null> {
  await respectRateLimit(url, 1500);

  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });

    // Extract publish date from meta tags
    const publishedAt = await page.evaluate((): Date | undefined => {
      const selectors = [
        'meta[property="article:published_time"]',
        'meta[name="pubdate"]',
        'meta[itemprop="datePublished"]',
        'time[datetime]',
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        const val = el?.getAttribute("content") ?? el?.getAttribute("datetime");
        if (val) {
          const d = new Date(val);
          if (!isNaN(d.getTime())) return d;
        }
      }
      return undefined;
    });

    const title = await page.title();
    const content = await page.evaluate(() => document.body.innerText);

    if (!content || content.length < MIN_CONTENT_LENGTH) {
      logger.warn({ url }, "Playwright returned insufficient content");
      return null;
    }

    return {
      url,
      title,
      content,
      publishedAt: publishedAt ? new Date(publishedAt) : undefined,
      method: "playwright",
    };
  } catch (err) {
    logger.warn({ err, url }, "Playwright fetch failed");
    return null;
  } finally {
    await context.close();
  }
}
