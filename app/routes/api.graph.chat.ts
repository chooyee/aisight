import type { ActionFunctionArgs } from "@react-router/node";
import { eq, inArray, like, or } from "drizzle-orm";
import { getDb } from "~/lib/db/client";
import {
  entities,
  events,
  relationships,
  articles,
  articleEntities,
  riskSignals,
} from "~/lib/db/schema";
import type { EntitySearchCandidate } from "~/lib/graphChat/search";
import { clearPendingResolution, getPendingResolution, setPendingResolution } from "~/lib/graphChat/sessionState";
import { buildQueryProfile, findEntityCandidates, resolveCandidateSelection } from "~/lib/graphChat/search";
import { logger } from "~/lib/logger";

// Reuse the Gemini setup from geminiExtract
import { GoogleGenerativeAI, HarmBlockThreshold, HarmCategory } from "@google/generative-ai";

// Optional Tavily for web search enrichment
let tavilySearch: ((query: string) => Promise<{ title: string; url: string; content: string }[]>) | null = null;

try {
  // Dynamic import to handle missing API key gracefully
  const { tavily } = await import("@tavily/core");
  const apiKey = process.env.TAVILY_API_KEY;
  if (apiKey) {
    const client = tavily({ apiKey });
    tavilySearch = async (query: string) => {
      const resp = await client.search(query, {
        maxResults: 3,
        topic: "news" as const,
        includeAnswer: false,
      });
      return resp.results.map((r: { title?: string; url?: string; content?: string }) => ({
        title: r.title ?? "",
        url: r.url ?? "",
        content: r.content ?? "",
      }));
    };
  }
} catch {
  // Tavily not available — that's OK
}

const SAFETY_SETTINGS = [
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
];

let _ai: GoogleGenerativeAI | undefined;
function getAI() {
  if (!_ai) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
    _ai = new GoogleGenerativeAI(apiKey);
  }
  return _ai;
}

type GraphChatResolution = {
  mode: "resolved" | "ambiguous" | "no_match";
  kind: "entity" | "event" | "none";
  candidates?: Array<{
    id: string;
    name: string;
    type: string;
    sector: string | null;
    country: string | null;
    score: number;
  }>;
};

function createEntityDisambiguationResponse(
  sessionId: string,
  question: string,
  candidates: EntitySearchCandidate[],
) {
  setPendingResolution(sessionId, candidates);

  const answer = [
    `I found several close matches for "${question.trim()}" in the graph.`,
    "Choose one so I can focus the answer and highlight the right part of the graph:",
    ...candidates.map((candidate, index) => {
      const details = [candidate.type, candidate.sector, candidate.country].filter(Boolean).join(" | ");
      return `${index + 1}. ${candidate.name}${details ? ` (${details})` : ""}`;
    }),
  ].join("\n");

  return Response.json({
    answer,
    context: {
      entitiesFound: candidates.length,
      eventsFound: 0,
      relationshipsFound: 0,
      riskSignalsFound: 0,
      webResultsUsed: 0,
    },
    highlightEntityIds: candidates.map((candidate) => candidate.id),
    highlightEventIds: [],
    resolution: {
      mode: "ambiguous",
      kind: "entity",
      candidates: candidates.map(({ id, name, type, sector, country, score }) => ({
        id,
        name,
        type,
        sector,
        country,
        score,
      })),
    } satisfies GraphChatResolution,
  });
}

function createNoMatchResponse(answer: string) {
  return Response.json({
    answer,
    context: {
      entitiesFound: 0,
      eventsFound: 0,
      relationshipsFound: 0,
      riskSignalsFound: 0,
      webResultsUsed: 0,
    },
    highlightEntityIds: [],
    highlightEventIds: [],
    resolution: {
      mode: "no_match",
      kind: "none",
    } satisfies GraphChatResolution,
  });
}

function buildEventKeywordFilter(question: string) {
  const profile = buildQueryProfile(question);
  const keywords = [...profile.phrases, ...profile.terms].slice(0, 6).map((term) => term.normalized).filter(Boolean);
  if (keywords.length === 0) return null;

  return or(
    ...keywords.flatMap((keyword) => [
      like(events.description, `%${keyword}%`),
      like(articles.title, `%${keyword}%`),
      like(riskSignals.riskType, `%${keyword}%`),
      like(riskSignals.rationale, `%${keyword}%`),
    ])
  );
}

function scoreEventText(question: string, textParts: Array<string | null>) {
  const profile = buildQueryProfile(question);
  const haystack = textParts.filter(Boolean).join(" ").toLowerCase();
  if (!haystack) return 0;

  let hits = 0;
  for (const term of [...profile.phrases, ...profile.terms]) {
    if (term.normalized && haystack.includes(term.normalized)) hits += 1;
  }
  if (hits === 0) return 0;
  return hits / Math.max(profile.terms.length || 1, 1);
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const body = await request.json();
  const { question, enableWebSearch, sessionId } = body as {
    question: string;
    enableWebSearch?: boolean;
    sessionId?: string;
  };

  if (!question || typeof question !== "string" || question.trim().length === 0) {
    return Response.json({ error: "Question is required" }, { status: 400 });
  }

  try {
    const db = getDb();
    const activeSessionId = sessionId?.trim();

    let resolvedEntityIds: string[] = [];

    if (activeSessionId) {
      const pending = getPendingResolution(activeSessionId);
      if (pending) {
        const resolved = resolveCandidateSelection(question, pending.candidates);
        if (resolved.candidate) {
          resolvedEntityIds = [resolved.candidate.id];
          clearPendingResolution(activeSessionId);
        } else if (resolved.stillAmbiguous) {
          return createEntityDisambiguationResponse(activeSessionId, question, pending.candidates);
        }
      }
    }

    // ── Step 1: Search the local knowledge graph ──────────────────────

    if (resolvedEntityIds.length === 0) {
      const allEntities = await db.select().from(entities);
      const rankedEntities = findEntityCandidates(question, allEntities, 8);
      const [best, second] = rankedEntities;

      if (best && best.score >= 0.88 && (!second || best.score - second.score >= 0.08)) {
        resolvedEntityIds = [best.id];
        if (activeSessionId) clearPendingResolution(activeSessionId);
      } else if (best && best.score >= 0.68 && second && best.score - second.score < 0.08 && activeSessionId) {
        return createEntityDisambiguationResponse(activeSessionId, question, rankedEntities.slice(0, 5));
      }
    }

    const relatedArticleIds = new Set<string>();

    const uniqueEntities = resolvedEntityIds.length > 0
      ? await db.select().from(entities).where(inArray(entities.id, resolvedEntityIds))
      : [];

    const relevantRelationships = resolvedEntityIds.length > 0
      ? await db
          .select()
          .from(relationships)
          .where(
            or(
              inArray(relationships.fromEntityId, resolvedEntityIds),
              inArray(relationships.toEntityId, resolvedEntityIds)
            )
          )
          .limit(40)
      : [];

    const relevantArticleEntities = resolvedEntityIds.length > 0
      ? await db
          .select()
          .from(articleEntities)
          .where(inArray(articleEntities.entityId, resolvedEntityIds))
      : [];

    for (const row of relevantArticleEntities) {
      relatedArticleIds.add(row.articleId);
    }

    let relevantEvents = relatedArticleIds.size > 0
      ? await db
          .select({
            id: events.id,
            articleId: events.articleId,
            description: events.description,
            eventType: events.eventType,
            occurredAt: events.occurredAt,
            articleTitle: articles.title,
            articleUrl: articles.url,
          })
          .from(events)
          .leftJoin(articles, eq(events.articleId, articles.id))
          .where(inArray(events.articleId, [...relatedArticleIds]))
          .limit(20)
      : [];

    let relevantRiskSignals = relevantEvents.length > 0
      ? await db
          .select()
          .from(riskSignals)
          .where(inArray(riskSignals.eventId, relevantEvents.map((event) => event.id)))
          .limit(20)
      : [];

    if (uniqueEntities.length === 0) {
      const eventFilter = buildEventKeywordFilter(question);
      if (eventFilter) {
        const fallbackRows = await db
          .select({
            id: events.id,
            articleId: events.articleId,
            description: events.description,
            eventType: events.eventType,
            occurredAt: events.occurredAt,
            articleTitle: articles.title,
            articleUrl: articles.url,
            riskType: riskSignals.riskType,
            riskRationale: riskSignals.rationale,
          })
          .from(events)
          .leftJoin(articles, eq(events.articleId, articles.id))
          .leftJoin(riskSignals, eq(riskSignals.eventId, events.id))
          .where(eventFilter)
          .limit(30);

        const rankedEvents = fallbackRows
          .map((row) => ({
            row,
            score: scoreEventText(question, [row.description, row.articleTitle, row.eventType, row.riskType, row.riskRationale]),
          }))
          .filter((entry) => entry.score >= 0.34)
          .sort((left, right) => right.score - left.score);

        const dedupedEvents = [...new Map(rankedEvents.map((entry) => [entry.row.id, entry.row])).values()].slice(0, 10);
        relevantEvents = dedupedEvents.map(({ riskType: _riskType, riskRationale: _riskRationale, ...event }) => event);

        for (const event of relevantEvents) {
          relatedArticleIds.add(event.articleId);
        }

        if (relatedArticleIds.size > 0) {
          const fallbackArticleEntities = await db
            .select()
            .from(articleEntities)
            .where(inArray(articleEntities.articleId, [...relatedArticleIds]));

          const fallbackEntityIds = [...new Set(fallbackArticleEntities.map((row) => row.entityId))].slice(0, 12);
          if (fallbackEntityIds.length > 0) {
            const linkedEntities = await db.select().from(entities).where(inArray(entities.id, fallbackEntityIds));
            uniqueEntities.push(...linkedEntities);
          }
        }

        relevantRiskSignals = relevantEvents.length > 0
          ? await db
              .select()
              .from(riskSignals)
              .where(inArray(riskSignals.eventId, relevantEvents.map((event) => event.id)))
              .limit(20)
          : [];
      }
    }

    if (uniqueEntities.length === 0 && relevantEvents.length === 0) {
      if (activeSessionId) clearPendingResolution(activeSessionId);
      return createNoMatchResponse(
        "I couldn't confidently match that to an entity, event, or risk signal in the graph. Try a company, regulator, event keyword, or a shorter phrase."
      );
    }

    const dedupedEntities = [...new Map(uniqueEntities.map((entity) => [entity.id, entity])).values()];

    // ── Step 2: Optionally enrich with web search ─────────────────────

    let webResults: { title: string; url: string; content: string }[] = [];
    if (enableWebSearch && tavilySearch) {
      try {
        webResults = await tavilySearch(question);
      } catch (err) {
        logger.warn({ err }, "Tavily web search failed for graph chat");
      }
    }

    // ── Step 3: Build context and call Gemini ─────────────────────────

    const entityContext = uniqueEntities
      .map((e) => `- ${e.name} (${e.type}${e.country ? `, ${e.country}` : ""}${e.sector ? `, sector: ${e.sector}` : ""})`)
      .join("\n");

    const relationshipContext = relevantRelationships
      .map((r) => {
        const from = uniqueEntities.find((e) => e.id === r.fromEntityId)?.name ?? r.fromEntityId;
        const to = uniqueEntities.find((e) => e.id === r.toEntityId)?.name ?? r.toEntityId;
        return `- ${from} → ${r.relationshipType} → ${to}`;
      })
      .join("\n");

    const eventContext = relevantEvents
      .map((e) => {
        const date = e.occurredAt ? new Date(e.occurredAt).toISOString().split("T")[0] : "unknown date";
        return `- [${e.eventType ?? "event"}] ${date}: ${e.description ?? "No description"} (source: ${e.articleTitle ?? e.articleUrl ?? "unknown"})`;
      })
      .join("\n");

    const riskContext = relevantRiskSignals
      .map((rs) => `- ${rs.riskType} (${rs.severity}, ${rs.direction}): ${rs.rationale ?? ""}`)
      .join("\n");

    const webContext = webResults.length > 0
      ? webResults.map((r) => `- "${r.title}" (${r.url}): ${r.content.slice(0, 300)}`).join("\n")
      : "";

    const prompt = `You are an intelligence analyst assistant for a Central Bank supervisor.
You have access to a knowledge graph of financial entities, events, and risk signals.
  Answer the user's question using the provided context. Be specific, cite sources when possible.
If the knowledge graph has limited information, say so clearly. If web search results are provided, incorporate them but distinguish between local knowledge and web findings.

  The graph search has already resolved the user's input to the closest matching graph nodes. Do not ask the user to restate the name unless the provided context is obviously insufficient.

## Knowledge Graph Context

### Entities Found (${uniqueEntities.length})
${dedupedEntities.map((e) => `- ${e.name} (${e.type}${e.country ? `, ${e.country}` : ""}${e.sector ? `, sector: ${e.sector}` : ""})`).join("\n") || "None found matching the query."}

### Relationships (${relevantRelationships.length})
${relationshipContext || "None found."}

### Events (${relevantEvents.length})
${eventContext || "None found."}

### Risk Signals (${relevantRiskSignals.length})
${riskContext || "None found."}

${webContext ? `### Web Search Results\n${webContext}` : ""}

## User Question
${question}

Respond in a clear, structured format. Use bullet points for lists. Mention entity types and dates where relevant. If you reference a web search result, include the URL.`;

    const model = getAI().getGenerativeModel({
      model: "gemini-3-flash-preview",
      safetySettings: SAFETY_SETTINGS,
    });

    const result = await model.generateContent(prompt);
    const answer = result.response.text();

    if (activeSessionId) clearPendingResolution(activeSessionId);

    return Response.json({
      answer,
      context: {
        entitiesFound: dedupedEntities.length,
        eventsFound: relevantEvents.length,
        relationshipsFound: relevantRelationships.length,
        riskSignalsFound: relevantRiskSignals.length,
        webResultsUsed: webResults.length,
      },
      // Return entity IDs so the frontend can highlight them in the graph
      highlightEntityIds: dedupedEntities.map((e) => e.id),
      highlightEventIds: relevantEvents.map((e) => e.id),
      resolution: {
        mode: "resolved",
        kind: dedupedEntities.length > 0 ? "entity" : "event",
      } satisfies GraphChatResolution,
    });
  } catch (err) {
    logger.error({ err }, "Graph chat failed");
    return Response.json(
      { error: "Failed to process question", detail: String(err) },
      { status: 500 }
    );
  }
}
