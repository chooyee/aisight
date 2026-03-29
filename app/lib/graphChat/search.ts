type EntityLike = {
  id: string;
  name: string;
  type: string;
  sector: string | null;
  country: string | null;
};

export type SearchTerm = {
  raw: string;
  normalized: string;
  compact: string;
};

export type QueryProfile = {
  raw: string;
  normalized: string;
  compact: string;
  terms: SearchTerm[];
  phrases: SearchTerm[];
};

export type EntitySearchCandidate = EntityLike & {
  score: number;
  matchedOn: string;
};

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "any",
  "about",
  "bank",
  "for",
  "from",
  "graph",
  "in",
  "into",
  "latest",
  "me",
  "of",
  "on",
  "or",
  "risk",
  "search",
  "show",
  "tell",
  "the",
  "to",
  "what",
  "who",
  "with",
]);

const LEGAL_SUFFIXES = new Set([
  "ag",
  "bank",
  "berhad",
  "co",
  "company",
  "corp",
  "corporation",
  "group",
  "holdings",
  "inc",
  "incorporated",
  "limited",
  "llc",
  "ltd",
  "plc",
  "sa",
]);

function stripMarks(value: string) {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
}

export function normalizeForSearch(value: string) {
  return stripMarks(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function compactForSearch(value: string) {
  return normalizeForSearch(value).replace(/\s+/g, "");
}

function tokenizeRaw(value: string) {
  return value.match(/[A-Za-z0-9.&'-]+/g) ?? [];
}

function buildTerm(raw: string): SearchTerm | null {
  const normalized = normalizeForSearch(raw);
  const compact = compactForSearch(raw);
  if (!normalized || !compact) return null;
  return { raw, normalized, compact };
}

function dedupeTerms(terms: SearchTerm[]) {
  const seen = new Set<string>();
  return terms.filter((term) => {
    const key = `${term.normalized}|${term.compact}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function buildQueryProfile(question: string): QueryProfile {
  const rawTokens = tokenizeRaw(question);
  const filteredTerms = rawTokens
    .map((raw) => ({ raw, compact: raw.replace(/[^A-Za-z0-9]/g, "") }))
    .filter(({ raw, compact }) => {
      if (!compact) return false;
      const lowered = compact.toLowerCase();
      if (compact.length >= 3) return !STOPWORDS.has(lowered);
      return /^[A-Z0-9]{2,6}$/.test(raw) && !STOPWORDS.has(lowered);
    })
    .map(({ raw }) => buildTerm(raw))
    .filter((term): term is SearchTerm => term !== null);

  const phrases: SearchTerm[] = [];
  for (let index = 0; index < filteredTerms.length; index += 1) {
    for (let width = 2; width <= 3; width += 1) {
      const slice = filteredTerms.slice(index, index + width);
      if (slice.length === width) {
        const phrase = buildTerm(slice.map((term) => term.raw).join(" "));
        if (phrase) phrases.push(phrase);
      }
    }
  }

  return {
    raw: question,
    normalized: normalizeForSearch(question),
    compact: compactForSearch(question),
    terms: dedupeTerms(filteredTerms),
    phrases: dedupeTerms(phrases),
  };
}

function meaningfulTokens(value: string) {
  return normalizeForSearch(value)
    .split(" ")
    .filter(Boolean)
    .filter((token) => !LEGAL_SUFFIXES.has(token));
}

function entityInitials(entity: EntityLike) {
  const tokens = meaningfulTokens(entity.name);
  return tokens.map((token) => token[0]).join("");
}

function bestSimilarity(term: string, candidates: string[]) {
  let best = 0;
  for (const candidate of candidates) {
    if (!candidate) continue;
    const similarity = normalizedSimilarity(term, candidate);
    if (similarity > best) best = similarity;
  }
  return best;
}

function normalizedSimilarity(left: string, right: string) {
  if (!left || !right) return 0;
  if (left === right) return 1;

  const maxLength = Math.max(left.length, right.length);
  if (maxLength === 0) return 1;
  if (Math.abs(left.length - right.length) > Math.max(4, Math.floor(maxLength * 0.5))) {
    return 0;
  }

  const rows = Array.from({ length: left.length + 1 }, () => new Array<number>(right.length + 1).fill(0));
  for (let i = 0; i <= left.length; i += 1) rows[i][0] = i;
  for (let j = 0; j <= right.length; j += 1) rows[0][j] = j;

  for (let i = 1; i <= left.length; i += 1) {
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      rows[i][j] = Math.min(
        rows[i - 1][j] + 1,
        rows[i][j - 1] + 1,
        rows[i - 1][j - 1] + cost
      );
    }
  }

  return 1 - rows[left.length][right.length] / maxLength;
}

function scoreAgainstText(term: SearchTerm, text: string) {
  const normalized = normalizeForSearch(text);
  const compact = compactForSearch(text);
  if (!normalized || !compact) return { score: 0, matchedOn: "" };

  if (term.normalized === normalized) return { score: 1, matchedOn: "exact" };
  if (term.compact === compact) return { score: 0.99, matchedOn: "exact-compact" };
  if (term.compact.length >= 2 && compact.startsWith(term.compact)) {
    return { score: 0.95, matchedOn: "compact-prefix" };
  }
  if (term.normalized.length >= 3 && normalized.includes(term.normalized)) {
    return { score: 0.9, matchedOn: "substring" };
  }

  const similarity = normalizedSimilarity(term.compact, compact);
  if (similarity >= 0.84) return { score: 0.78 + similarity * 0.12, matchedOn: "fuzzy" };
  return { score: 0, matchedOn: "" };
}

export function scoreEntityCandidate(query: QueryProfile, entity: EntityLike) {
  const normalizedName = normalizeForSearch(entity.name);
  const compactName = compactForSearch(entity.name);
  const meaningful = meaningfulTokens(entity.name);
  const initials = entityInitials(entity);
  const descriptors = [entity.type, entity.sector ?? "", entity.country ?? ""].map(normalizeForSearch).filter(Boolean);

  const directTerms = [
    ...query.phrases,
    buildTerm(query.raw),
    ...query.terms,
  ].filter((term): term is SearchTerm => term !== null);

  let bestScore = 0;
  let matchedOn = "";

  for (const term of directTerms) {
    const direct = scoreAgainstText(term, entity.name);
    if (direct.score > bestScore) {
      bestScore = direct.score;
      matchedOn = direct.matchedOn;
    }

    if (term.compact === initials && initials.length >= 2 && bestScore < 0.9) {
      bestScore = 0.88;
      matchedOn = "initials";
    }

    if (meaningful.includes(term.normalized) && bestScore < 0.88) {
      bestScore = 0.86;
      matchedOn = "token";
    }

    const tokenPrefix = meaningful.some((token) => token.startsWith(term.normalized) && term.normalized.length >= 2);
    if (tokenPrefix && bestScore < 0.82) {
      bestScore = 0.8;
      matchedOn = "token-prefix";
    }

    const fuzzyName = bestSimilarity(term.compact, [compactName, ...meaningful]);
    if (fuzzyName >= 0.8) {
      const fuzzyScore = 0.68 + fuzzyName * 0.18;
      if (fuzzyScore > bestScore) {
        bestScore = fuzzyScore;
        matchedOn = "fuzzy";
      }
    }

    const descriptorHit = descriptors.some((descriptor) => descriptor.includes(term.normalized));
    if (descriptorHit && bestScore < 0.7) {
      bestScore = 0.68;
      matchedOn = "descriptor";
    }
  }

  if (query.terms.length > 1) {
    const overlap = query.terms.filter((term) => normalizedName.includes(term.normalized)).length;
    if (overlap > 0) {
      const overlapScore = 0.58 + overlap / query.terms.length * 0.24;
      if (overlapScore > bestScore) {
        bestScore = overlapScore;
        matchedOn = "overlap";
      }
    }
  }

  return { score: Number(bestScore.toFixed(4)), matchedOn };
}

export function findEntityCandidates<T extends EntityLike>(question: string, entities: T[], limit = 8) {
  const query = buildQueryProfile(question);
  return entities
    .map((entity) => {
      const { score, matchedOn } = scoreEntityCandidate(query, entity);
      return {
        ...entity,
        score,
        matchedOn,
      } satisfies EntitySearchCandidate;
    })
    .filter((candidate) => candidate.score >= 0.52)
    .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))
    .slice(0, limit);
}

export function resolveCandidateSelection<T extends EntityLike>(selection: string, candidates: T[]) {
  const normalized = normalizeForSearch(selection);
  const compact = compactForSearch(selection);

  const ordinalLookup = new Map<string, number>([
    ["1", 0],
    ["first", 0],
    ["one", 0],
    ["2", 1],
    ["second", 1],
    ["two", 1],
    ["3", 2],
    ["third", 2],
    ["three", 2],
    ["4", 3],
    ["fourth", 3],
    ["four", 3],
  ]);

  const ordinal = ordinalLookup.get(normalized);
  if (ordinal !== undefined && candidates[ordinal]) {
    return { candidate: candidates[ordinal], stillAmbiguous: false };
  }

  const ranked = candidates
    .map((candidate) => {
      const base = scoreEntityCandidate(buildQueryProfile(selection), candidate).score;
      let score = base;
      const descriptor = normalizeForSearch(`${candidate.name} ${candidate.type} ${candidate.sector ?? ""} ${candidate.country ?? ""}`);
      if (normalized && descriptor.includes(normalized)) score = Math.max(score, 0.88);
      if (compact && compactForSearch(candidate.name).startsWith(compact)) score = Math.max(score, 0.93);
      return { candidate, score };
    })
    .sort((left, right) => right.score - left.score);

  const [best, second] = ranked;
  if (!best || best.score < 0.72) {
    return { candidate: null, stillAmbiguous: true };
  }
  if (second && best.score - second.score < 0.08) {
    return { candidate: null, stillAmbiguous: true };
  }

  return { candidate: best.candidate, stillAmbiguous: false };
}
