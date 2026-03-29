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
  entityAffiliations,
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

    // ── Step 5b: Extract year context from the question ──────────────────────
    // Used to filter affiliations temporally (e.g. "who was CEO in 2017?")

    const yearMatches = question.match(/\b(19|20)\d{2}\b/g);
    const mentionedYears = yearMatches ? [...new Set(yearMatches.map(Number))].sort() : [];

    // Returns true if an affiliation was active during a given year.
    // Dates are stored as text: "YYYY", "YYYY-MM", or "YYYY-MM-DD".
    function affiliationActiveInYear(
      aff: { startDate: string | null; endDate: string | null; isCurrent: boolean },
      year: number
    ): boolean {
      const startYear = aff.startDate ? parseInt(aff.startDate.slice(0, 4)) : null;
      const endYear = aff.endDate ? parseInt(aff.endDate.slice(0, 4)) : null;
      if (startYear !== null && startYear > year) return false;
      if (endYear !== null && endYear < year) return false;
      return true;
    }

    // ── Step 6: Fetch affiliations for matched entities (both directions) ─────
    // "outgoing": this entity held a role at another entity
    // "incoming": another entity held a role at/in this entity (e.g. person→company)

    const allAffiliations = matchedEntityIds.size > 0
      ? await db
          .select({
            aff: entityAffiliations,
            subjectName: entities.name,
            subjectType: entities.type,
            subjectId: entities.id,
          })
          .from(entityAffiliations)
          .leftJoin(entities, eq(entityAffiliations.entityId, entities.id))
          .where(
            or(
              inArray(entityAffiliations.entityId, [...matchedEntityIds]),
              inArray(entityAffiliations.relatedEntityId, [...matchedEntityIds])
            )
          )
      : [];

    // Fetch the related-entity names too (for display in context)
    const affiliationRelatedIds = new Set(allAffiliations.map((r) => r.aff.relatedEntityId));
    const affiliationRelatedEntities = affiliationRelatedIds.size > 0
      ? await db.select({ id: entities.id, name: entities.name, type: entities.type })
          .from(entities)
          .where(inArray(entities.id, [...affiliationRelatedIds]))
      : [];
    const relatedEntityMap = new Map(affiliationRelatedEntities.map((e) => [e.id, e]));

    // Split into year-relevant (if years mentioned) vs all
    const temporallyRelevantAffiliations = mentionedYears.length > 0
      ? allAffiliations.filter((r) =>
          mentionedYears.some((yr) => affiliationActiveInYear(r.aff, yr))
        )
      : allAffiliations;

    // Collect affiliated entity IDs to include in subgraph
    const affiliationEntityIds = new Set<string>();
    for (const { aff } of temporallyRelevantAffiliations) {
      affiliationEntityIds.add(aff.entityId);
      affiliationEntityIds.add(aff.relatedEntityId);
    }

    // ── Step 6b: Fetch 1-hop neighbour entities (relationships + affiliations) ─

    const neighborEntityIds = new Set<string>();
    for (const r of relevantRelationships) {
      if (!matchedEntityIds.has(r.fromEntityId)) neighborEntityIds.add(r.fromEntityId);
      if (!matchedEntityIds.has(r.toEntityId)) neighborEntityIds.add(r.toEntityId);
    }
    for (const id of affiliationEntityIds) {
      if (!matchedEntityIds.has(id)) neighborEntityIds.add(id);
    }
    const neighborEntities = neighborEntityIds.size > 0
      ? await db.select().from(entities)
          .where(inArray(entities.id, [...neighborEntityIds]))
      : [];

    const allSubgraphEntities = [...uniqueEntities, ...neighborEntities];
    const allSubgraphEntityIds = new Set(allSubgraphEntities.map((e) => e.id));

    // ── Step 6c: Pre-compute accountability chains ────────────────────────────
    // For each event, resolve: WHICH person held a leadership role at the
    // involved entity AT THE TIME the event occurred.
    // This gives Gemini a pre-computed chain so it doesn't have to guess.

    const accountabilityChains: string[] = [];
    for (const ev of relevantEvents.slice(0, 15)) {
      const eventDate = ev.occurredAt ? new Date(ev.occurredAt) : null;
      const eventYear = eventDate?.getFullYear() ?? null;
      const eventDateStr = eventDate ? eventDate.toISOString().split("T")[0] : "unknown date";

      // Entities mentioned in the same article as this event
      const entitiesInArticle = matchedAE
        .filter((ae) => ae.articleId === ev.articleId)
        .map((ae) => ae.entityId)
        .slice(0, 3);

      for (const entityId of entitiesInArticle) {
        const entity = allSubgraphEntities.find((e) => e.id === entityId);
        if (!entity) continue;

        // People who held employment/board roles at this entity at the event time
        const leaders = allAffiliations.filter(({ aff }) => {
          // Must be an "incoming" affiliation — person/entity → this company
          if (aff.relatedEntityId !== entityId) return false;
          if (!["employment", "board"].includes(aff.affiliationType)) return false;
          if (eventYear && !affiliationActiveInYear(aff, eventYear)) return false;
          return true;
        });

        if (leaders.length > 0) {
          const leaderStr = leaders
            .slice(0, 3)
            .map(({ aff, subjectName }) => {
              const period = aff.startDate || aff.endDate
                ? ` [${aff.startDate ?? "?"}–${aff.endDate ?? "present"}]`
                : "";
              return `${subjectName ?? "?"} as ${aff.role ?? aff.affiliationType}${period}`;
            })
            .join("; ");
          accountabilityChains.push(
            `• [${eventDateStr}] "${ev.description?.slice(0, 100) ?? ev.eventType}" @ ${entity.name} — In charge: ${leaderStr}`
          );
        }
      }
    }

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

    // Build affiliation context — show ALL affiliations for matched entities,
    // clearly marking which were active vs inactive during mentioned years.
    const allEntitiesMap = new Map([...uniqueEntities, ...neighborEntities].map((e) => [e.id, e]));
    const affiliationContext = allAffiliations.length > 0
      ? allAffiliations
          .map(({ aff, subjectName, subjectType }) => {
            const related = relatedEntityMap.get(aff.relatedEntityId);
            const subject = subjectName ?? allEntitiesMap.get(aff.entityId)?.name ?? aff.entityId;
            const relatedName = related?.name ?? aff.relatedEntityId;
            const period = aff.startDate || aff.endDate
              ? `[${aff.startDate ?? "?"}–${aff.endDate ?? "present"}]`
              : aff.isCurrent ? "[current]" : "[dates unknown]";

            // Check temporal relevance against mentioned years
            let temporalNote = "";
            if (mentionedYears.length > 0) {
              const activeYears = mentionedYears.filter((yr) => affiliationActiveInYear(aff, yr));
              const inactiveYears = mentionedYears.filter((yr) => !affiliationActiveInYear(aff, yr));
              if (activeYears.length > 0) temporalNote = ` ← ACTIVE in ${activeYears.join(", ")}`;
              else if (inactiveYears.length > 0) temporalNote = ` ← NOT active in ${inactiveYears.join(", ")}`;
            }

            return `- ${subject} (${subjectType ?? "?"}) was ${aff.role ?? aff.affiliationType} of ${relatedName} ${period}${temporalNote}`;
          })
          .join("\n")
      : "";

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

    const temporalInstruction = mentionedYears.length > 0
      ? `CRITICAL: This question refers to year(s) ${mentionedYears.join(", ")}. You MUST use the Affiliation History and Accountability Chains below to identify who held each role DURING THAT PERIOD — NOT the current role-holder. Affiliations marked "← ACTIVE in YYYY" are correct for that year. Affiliations marked "← NOT active in YYYY" must NOT be cited as responsible.`
      : "";

    const prompt = `You are an intelligence analyst assistant for a Central Bank supervisor.
You have access to a knowledge graph including entities, events, risk signals, and a verified time-bounded affiliation history showing who held which role at which organisation and when.

Your primary job when asked about causes, responsibility, or accountability: trace the chain from the event → the entity involved → the person who held the leadership role at that entity AT THE TIME of the event, using the Accountability Chains section below.

${temporalInstruction}

## Knowledge Graph Context

### Entities Found (${uniqueEntities.length})
${entityContext || "None found matching the query."}

### Accountability Chains — Pre-resolved: Event → Entity → Person In Charge at Event Time (${accountabilityChains.length})
${accountabilityChains.length > 0 ? accountabilityChains.join("\n") : "No chains resolved — affiliation data may be incomplete for these entities."}

### Full Affiliation History (${allAffiliations.length} records)
${affiliationContext || "No affiliation records found for these entities."}

### Events (${relevantEvents.length})
${eventContext || "None found."}

### Risk Signals (${relevantRiskSignals.length})
${riskContext || "None found."}

### AI-Extracted Relationships (${relevantRelationships.length})
${relationshipContext || "None found."}

${webContext ? `### Web Search Results\n${webContext}` : ""}

## User Question
${question}

Answer in clear, structured format. When attributing responsibility, always state: the person's name, their role, and the specific time period they held it. Distinguish clearly between past role-holders and current ones.`;

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

    // Affiliation edges — only those temporally relevant to the question
    const affiliationEdges = temporallyRelevantAffiliations
      .filter((r) => allSubgraphEntityIds.has(r.aff.entityId) && allSubgraphEntityIds.has(r.aff.relatedEntityId))
      .map(({ aff }) => {
        const label = aff.role
          ? aff.isCurrent ? aff.role : `${aff.role} (past)`
          : aff.affiliationType;
        return {
          data: {
            id: `aff_${aff.id}`,
            source: aff.entityId,
            target: aff.relatedEntityId,
            label,
            edgeType: "affiliation" as const,
            isCurrent: aff.isCurrent,
            weight: null,
          },
        };
      });

    // Build involvement edges from the already-filtered articleEntities
    const articleToEventIds = new Map<string, string[]>();
    for (const ev of relevantEvents) {
      if (!articleToEventIds.has(ev.articleId)) articleToEventIds.set(ev.articleId, []);
      articleToEventIds.get(ev.articleId)!.push(ev.id);
    }
    const seenPairs = new Set<string>();
    const involvementEdges: { data: { id: string; source: string; target: string; label: string; edgeType: "relationship" | "involvement" | "affiliation"; weight: number | null } }[] = [];
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
        affiliationsFound: allAffiliations.length,
        relationshipsFound: relevantRelationships.length,
        riskSignalsFound: relevantRiskSignals.length,
        webResultsUsed: webResults.length,
      },
      highlightEntityIds: uniqueEntities.map((e) => e.id),
      highlightEventIds: relevantEvents.map((e) => e.id),
      // Complete subgraph for the frontend to render — only what's needed
      subgraph: {
        nodes: [...entityNodes, ...eventNodes],
        edges: [...relEdges, ...affiliationEdges, ...involvementEdges],
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
