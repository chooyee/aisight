// Per-domain token-bucket rate limiter.
// Ensures minimum delay between requests to the same domain.

const lastRequestTime = new Map<string, number>();
const DEFAULT_DELAY_MS = 800;

function getDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export async function respectRateLimit(url: string, delayMs = DEFAULT_DELAY_MS) {
  const domain = getDomain(url);
  const last = lastRequestTime.get(domain) ?? 0;
  const now = Date.now();
  const elapsed = now - last;

  if (elapsed < delayMs) {
    await new Promise((r) => setTimeout(r, delayMs - elapsed));
  }

  lastRequestTime.set(domain, Date.now());
}
