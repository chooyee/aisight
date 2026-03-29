import type { LoaderFunctionArgs } from "@react-router/node";
import { eq, and, or, gte, lt, isNull } from "drizzle-orm";
import { getDb } from "~/lib/db/client";
import { entities, relationships, events, articleEntities, articles, entityAffiliations } from "~/lib/db/schema";

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const sector = url.searchParams.get("sector");
  const year = url.searchParams.get("year");
  const month = url.searchParams.get("month");

  const db = getDb();

  // ── Step 1: Build the time filter ─────────────────────────────────────────
  // occurredAt can be NULL when the LLM couldn't parse a date from the article.
  // Fallback: if occurredAt IS NULL, use the article's publishedAt instead.
  let timeFilter: ReturnType<typeof or> | undefined;
  if (year) {
    const y = parseInt(year, 10);
    if (!isNaN(y)) {
      let start: Date;
      let end: Date;
      if (month) {
        const m = parseInt(month, 10);
        if (!isNaN(m) && m >= 1 && m <= 12) {
          start = new Date(y, m - 1, 1);
          end = new Date(y, m, 1);
        } else {
          start = new Date(y, 0, 1);
          end = new Date(y + 1, 0, 1);
        }
      } else {
        start = new Date(y, 0, 1);
        end = new Date(y + 1, 0, 1);
      }
      timeFilter = or(
        and(gte(events.occurredAt, start), lt(events.occurredAt, end)),
        and(isNull(events.occurredAt), gte(articles.publishedAt, start), lt(articles.publishedAt, end))
      );
    }
  }

  // ── Step 2: Fetch events (time-filtered) ──────────────────────────────────
  const eventRows = await db
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
    .where(timeFilter);

  const eventIds = new Set(eventRows.map((e) => e.id));

  // ── Step 3: Derive which entities are relevant to the filtered events ──────
  // When a time filter is active, only show entities that appear in at least
  // one article that has a matching event. Prevents orphaned entity nodes.
  const aeRows = await db.select().from(articleEntities);

  let activeEntityIds: Set<string> | null = null;
  if (timeFilter) {
    const filteredArticleIds = new Set(eventRows.map((e) => e.articleId));
    activeEntityIds = new Set(
      aeRows
        .filter((ae) => filteredArticleIds.has(ae.articleId))
        .map((ae) => ae.entityId)
    );
  }

  // ── Step 4: Fetch entities, optionally filtered by sector + active set ─────
  const allEntityRows = await db
    .select()
    .from(entities)
    .where(sector ? eq(entities.sector, sector) : undefined);

  // When time filter is active, drop entities not connected to any filtered event
  const entityRows = activeEntityIds
    ? allEntityRows.filter((e) => activeEntityIds!.has(e.id))
    : allEntityRows;

  const nodeIds = new Set(entityRows.map((e) => e.id));

  // Build event nodes
  const eventNodes = eventRows.map((e) => ({
    data: {
      id: e.id,
      label: e.description?.slice(0, 60) ?? e.eventType ?? "Event",
      nodeType: "event" as const,
      eventType: e.eventType ?? "other",
      occurredAt: e.occurredAt?.toISOString() ?? null,
      articleTitle: e.articleTitle ?? null,
      articleUrl: e.articleUrl ?? null,
      description: e.description ?? null,
    },
  }));

  // Build entity nodes
  const entityNodes = entityRows.map((e) => ({
    data: {
      id: e.id,
      label: e.name,
      nodeType: "entity" as const,
      entityType: e.type,
      sector: e.sector,
      country: e.country,
    },
  }));

  // ── Step 5: Relationship edges (entity↔entity, AI-extracted) ─────────────
  const relRows = await db.select().from(relationships);
  const relEdges = relRows
    .filter((r) => nodeIds.has(r.fromEntityId) && nodeIds.has(r.toEntityId))
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

  // ── Step 5b: Affiliation edges (manual + LLM-researched) ─────────────────
  // Show ALL affiliations (current + past) so the graph tells the full story.
  const affRows = await db.select().from(entityAffiliations);
  const affiliationEdges = affRows
    .filter((a) => nodeIds.has(a.entityId) && nodeIds.has(a.relatedEntityId))
    .map((a) => {
      const label = a.role
        ? a.isCurrent ? a.role : `${a.role} (past)`
        : a.affiliationType;
      return {
        data: {
          id: `aff_${a.id}`,
          source: a.entityId,
          target: a.relatedEntityId,
          label,
          edgeType: "affiliation" as const,
          isCurrent: a.isCurrent,
          ownershipPct: a.ownershipPct,
          affiliationType: a.affiliationType,
        },
      };
    });

  // ── Step 6: Involvement edges (entity↔event via shared article) ───────────

  // Build a map: articleId -> entityIds
  const articleToEntities = new Map<string, Set<string>>();
  for (const ae of aeRows) {
    if (!nodeIds.has(ae.entityId)) continue;
    let set = articleToEntities.get(ae.articleId);
    if (!set) {
      set = new Set();
      articleToEntities.set(ae.articleId, set);
    }
    set.add(ae.entityId);
  }

  // Build a map: articleId -> eventIds
  const articleToEvents = new Map<string, Set<string>>();
  for (const ev of eventRows) {
    if (!eventIds.has(ev.id)) continue;
    let set = articleToEvents.get(ev.articleId);
    if (!set) {
      set = new Set();
      articleToEvents.set(ev.articleId, set);
    }
    set.add(ev.id);
  }

  // Generate involvement edges
  const involvementEdges: { data: { id: string; source: string; target: string; label: string; edgeType: "involvement" } }[] = [];
  const seenPairs = new Set<string>();

  for (const [articleId, entIds] of articleToEntities) {
    const evIds = articleToEvents.get(articleId);
    if (!evIds) continue;
    for (const entityId of entIds) {
      for (const eventId of evIds) {
        const pairKey = `${entityId}:${eventId}`;
        if (seenPairs.has(pairKey)) continue;
        seenPairs.add(pairKey);
        involvementEdges.push({
          data: {
            id: `inv_${entityId}_${eventId}`,
            source: entityId,
            target: eventId,
            label: "involved_in",
            edgeType: "involvement",
          },
        });
      }
    }
  }

  const nodes = [...entityNodes, ...eventNodes];
  const edges = [...relEdges, ...affiliationEdges, ...involvementEdges];

  return Response.json(
    {
      nodes,
      edges,
      entityCount: entityNodes.length,
      eventCount: eventNodes.length,
      edgeCount: edges.length,
      affiliationEdgeCount: affiliationEdges.length,
    },
    { headers: { "Cache-Control": "max-age=60" } }
  );
}
