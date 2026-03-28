import { createHash } from "node:crypto";

/** SHA-256 of normalised URL — used as the dedup key in `articles.url_hash`. */
export function hashUrl(url: string): string {
  const normalised = url.split("?")[0].split("#")[0].toLowerCase().replace(/\/$/, "");
  return createHash("sha256").update(normalised).digest("hex");
}

/** Rough title similarity check (Jaccard on word tokens, threshold 0.8). */
export function isTitleDuplicate(a: string, b: string): boolean {
  const tokenise = (s: string) =>
    new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(Boolean));
  const tokA = tokenise(a);
  const tokB = tokenise(b);
  const intersection = [...tokA].filter((t) => tokB.has(t)).length;
  const union = new Set([...tokA, ...tokB]).size;
  return union > 0 && intersection / union >= 0.8;
}
