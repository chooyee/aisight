import type { ActionFunctionArgs } from "@react-router/node";
import { eq, like, or, inArray } from "drizzle-orm";
import { getDb } from "~/lib/db/client";
import {
  entities,
  events,
  relationships,
  articles,
  articleEntities,
  riskSignals,
} from "~/lib/db/schema";
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

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const body = await request.json();
  const { question, enableWebSearch } = body as { question: string; enableWebSearch?: boolean };

  if (!question || typeof question !== "string" || question.trim().length === 0) {
    return Response.json({ error: "Question is required" }, { status: 400 });
  }

  try {
    const db = getDb();

    // ── Step 1: Keyword-match entities ───────────────────────────────────────

    const keywords = question
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 2)
      .slice(0, 5);

    const matchedEntities = [];
    for (const kw of keywords) {
      const results = await db
        .select()
        .from(entities)
        .where(like(entities.name, `%${kw}%`))
        .limit(10);
      matchedEntities.push(...results);
    }
    const uniqueEntities = [...new Map(matchedEntities.map((e) => [e.id, e])).values()].slice(0, 15);
    const matchedEntityIds = new Set(uniqueEntities.map((e) => e.id));

    // ── Step 2: Fetch only articleEntities rows for matched entities ──────────

    const matchedAE = matchedEntityIds.size > 0
      ? await db.select().from(articleEntities)
          .where(inArray(articleEntities.entityId, [...matchedEntityIds]))
      : [];
    const relevantArticleIds = new Set(matchedAE.map((ae) => ae.articleId));

    // ── Step 3: Fetch events only for those articles ──────────────────────────

    const relevantEvents = relevantArticleIds.size > 0
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
          .where(inArray(events.articleId, [...relevantArticleIds]))
          .limit(20)
      : [];

    // ── Step 4: Fetch relationships for matched entities only ─────────────────

    const relevantRelationships = matchedEntityIds.size > 0
      ? await db.select().from(relationships).where(
          or(
            inArray(relationships.fromEntityId, [...matchedEntityIds]),
            inArray(relationships.toEntityId, [...matchedEntityIds])
          )
        )
      : [];

    // ── Step 5: Fetch risk signals for context ────────────────────────────────

    const relevantEventIds = new Set(relevantEvents.map((e) => e.id));
    const relevantRiskSignals = relevantEventIds.size > 0
      ? await db.select().from(riskSignals)
          .where(inArray(riskSignals.eventId, [...relevantEventIds]))
          .limit(20)
      : [];

    // ── Step 6: Fetch 1-hop neighbour entities ────────────────────────────────

    const neighborEntityIds = new Set<string>();
    for (const r of relevantRelationships) {
      if (!matchedEntityIds.has(r.fromEntityId)) neighborEntityIds.add(r.fromEntityId);
      if (!matchedEntityIds.has(r.toEntityId)) neighborEntityIds.add(r.toEntityId);
    }
    const neighborEntities = neighborEntityIds.size > 0
      ? await db.select().from(entities)
          .where(inArray(entities.id, [...neighborEntityIds]))
      : [];

    const allSubgraphEntities = [...uniqueEntities, ...neighborEntities];
    const allSubgraphEntityIds = new Set(allSubgraphEntities.map((e) => e.id));

    // ── Step 7: Fetch articleEntities for relevant articles (involvement edges) ─

    const relevantAE = relevantArticleIds.size > 0
      ? await db.select().from(articleEntities)
          .where(inArray(articleEntities.articleId, [...relevantArticleIds]))
      : [];

    // ── Step 8: Optionally enrich with web search ─────────────────────────────

    let webResults: { title: string; url: string; content: string }[] = [];
    if (enableWebSearch && tavilySearch) {
      try {
        webResults = await tavilySearch(question);
      } catch (err) {
        logger.warn({ err }, "Tavily web search failed for graph chat");
      }
    }

    // ── Step 9: Build LLM context and call Gemini ─────────────────────────────

    const entityContext = uniqueEntities
      .map((e) => `- ${e.name} (${e.type}${e.country ? `, ${e.country}` : ""}${e.sector ? `, sector: ${e.sector}` : ""})`)
      .join("\n");

    const relationshipContext = relevantRelationships
      .map((r) => {
        const from = uniqueEntities.find((e) => e.id === r.fromEntityId)?.name ?? r.fromEntityId;
        const to = (uniqueEntities.find((e) => e.id === r.toEntityId) ?? neighborEntities.find((e) => e.id === r.toEntityId))?.name ?? r.toEntityId;
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

## Knowledge Graph Context

### Entities Found (${uniqueEntities.length})
${entityContext || "None found matching the query."}

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

    // ── Step 10: Build subgraph for the frontend ──────────────────────────────

    const entityNodes = allSubgraphEntities.map((e) => ({
      data: {
        id: e.id,
        label: e.name,
        nodeType: "entity" as const,
        entityType: e.type,
        sector: e.sector,
        country: e.country,
      },
    }));

    const eventNodes = relevantEvents.map((e) => ({
      data: {
        id: e.id,
        label: e.description?.slice(0, 60) ?? e.eventType ?? "Event",
        nodeType: "event" as const,
        eventType: e.eventType ?? "other",
        occurredAt: e.occurredAt ? new Date(e.occurredAt).toISOString() : null,
        articleTitle: e.articleTitle ?? null,
        articleUrl: e.articleUrl ?? null,
        description: e.description ?? null,
      },
    }));

    const relEdges = relevantRelationships
      .filter((r) => allSubgraphEntityIds.has(r.fromEntityId) && allSubgraphEntityIds.has(r.toEntityId))
      .map((r) => ({
        data: {
          id: r.id,
          source: r.fromEntityId,
          target: r.toEntityId,
          label: r.relationshipType,
          edgeType: "relationship" as const,
          weight: r.weight,
        },
      }));

    // Build involvement edges from the already-filtered articleEntities
    const articleToEventIds = new Map<string, string[]>();
    for (const ev of relevantEvents) {
      if (!articleToEventIds.has(ev.articleId)) articleToEventIds.set(ev.articleId, []);
      articleToEventIds.get(ev.articleId)!.push(ev.id);
    }
    const seenPairs = new Set<string>();
    const involvementEdges: typeof relEdges = [];
    for (const ae of relevantAE) {
      if (!allSubgraphEntityIds.has(ae.entityId)) continue;
      const evIds = articleToEventIds.get(ae.articleId);
      if (!evIds) continue;
      for (const evId of evIds) {
        const key = `${ae.entityId}:${evId}`;
        if (seenPairs.has(key)) continue;
        seenPairs.add(key);
        involvementEdges.push({
          data: {
            id: `inv_${ae.entityId}_${evId}`,
            source: ae.entityId,
            target: evId,
            label: "involved_in",
            edgeType: "involvement" as const,
            weight: null,
          },
        });
      }
    }

    return Response.json({
      answer,
      context: {
        entitiesFound: uniqueEntities.length,
        eventsFound: relevantEvents.length,
        relationshipsFound: relevantRelationships.length,
        riskSignalsFound: relevantRiskSignals.length,
        webResultsUsed: webResults.length,
      },
      highlightEntityIds: uniqueEntities.map((e) => e.id),
      highlightEventIds: relevantEvents.map((e) => e.id),
      // Complete subgraph for the frontend to render — only what's needed
      subgraph: {
        nodes: [...entityNodes, ...eventNodes],
        edges: [...relEdges, ...involvementEdges],
      },
    });
  } catch (err) {
    logger.error({ err }, "Graph chat failed");
    return Response.json(
      { error: "Failed to process question", detail: String(err) },
      { status: 500 }
    );
  }
}
