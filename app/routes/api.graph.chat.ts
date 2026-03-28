import type { ActionFunctionArgs } from "@react-router/node";
import { eq, like, or } from "drizzle-orm";
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

    // ── Step 1: Search the local knowledge graph ──────────────────────

    // Extract keywords from the question (simple: split on spaces, take significant words)
    const keywords = question
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 2)
      .slice(0, 5);

    // Search entities by name
    const matchedEntities = [];
    for (const kw of keywords) {
      const results = await db
        .select()
        .from(entities)
        .where(like(entities.name, `%${kw}%`))
        .limit(10);
      matchedEntities.push(...results);
    }
    // Deduplicate by ID
    const uniqueEntities = [...new Map(matchedEntities.map((e) => [e.id, e])).values()].slice(0, 15);

    // Get relationships involving these entities
    const entityIds = new Set(uniqueEntities.map((e) => e.id));
    const allRelationships = await db.select().from(relationships);
    const relevantRelationships = allRelationships.filter(
      (r) => entityIds.has(r.fromEntityId) || entityIds.has(r.toEntityId)
    );

    // Get articles linked to these entities
    const allAE = await db.select().from(articleEntities);
    const relevantArticleIds = new Set(
      allAE.filter((ae) => entityIds.has(ae.entityId)).map((ae) => ae.articleId)
    );

    // Get events linked to those articles
    const allEvents = await db
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
      .leftJoin(articles, eq(events.articleId, articles.id));

    const relevantEvents = allEvents
      .filter((e) => relevantArticleIds.has(e.articleId))
      .slice(0, 20);

    // Get risk signals for relevant events
    const relevantEventIds = new Set(relevantEvents.map((e) => e.id));
    const allRiskSignals = await db.select().from(riskSignals);
    const relevantRiskSignals = allRiskSignals
      .filter((rs) => relevantEventIds.has(rs.eventId))
      .slice(0, 20);

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

    return Response.json({
      answer,
      context: {
        entitiesFound: uniqueEntities.length,
        eventsFound: relevantEvents.length,
        relationshipsFound: relevantRelationships.length,
        riskSignalsFound: relevantRiskSignals.length,
        webResultsUsed: webResults.length,
      },
      // Return entity IDs so the frontend can highlight them in the graph
      highlightEntityIds: uniqueEntities.map((e) => e.id),
      highlightEventIds: relevantEvents.map((e) => e.id),
    });
  } catch (err) {
    logger.error({ err }, "Graph chat failed");
    return Response.json(
      { error: "Failed to process question", detail: String(err) },
      { status: 500 }
    );
  }
}
