import type { LoaderFunctionArgs } from "react-router";
import { eq } from "drizzle-orm";
import { getDb } from "~/lib/db/client";
import { articles, articleEntities, entities, events, riskSignals } from "~/lib/db/schema";

export async function loader({ params }: LoaderFunctionArgs) {
  const { id } = params;
  if (!id) return new Response("id required", { status: 400 });

  const db = getDb();

  const [article] = await db.select().from(articles).where(eq(articles.id, id)).limit(1);
  if (!article) return new Response("Not found", { status: 404 });

  const entityTags = await db
    .select({
      id: entities.id,
      name: entities.name,
      type: entities.type,
      country: entities.country,
      confidence: articleEntities.confidence,
      context: articleEntities.context,
    })
    .from(articleEntities)
    .innerJoin(entities, eq(articleEntities.entityId, entities.id))
    .where(eq(articleEntities.articleId, id));

  const articleEvents = await db
    .select()
    .from(events)
    .where(eq(events.articleId, id));

  const eventIds = articleEvents.map((e) => e.id);
  const signals = eventIds.length > 0
    ? await db
        .select({
          id: riskSignals.id,
          eventId: riskSignals.eventId,
          riskType: riskSignals.riskType,
          category: riskSignals.category,
          severity: riskSignals.severity,
          direction: riskSignals.direction,
          rationale: riskSignals.rationale,
        })
        .from(riskSignals)
        .where(
          eventIds.length === 1
            ? eq(riskSignals.eventId, eventIds[0])
            : eq(riskSignals.eventId, eventIds[0]) // handled client-side via eventId match
        )
    : [];

  // Fetch all signals for all events
  const allSignals = await Promise.all(
    articleEvents.map((ev) =>
      db.select({
        id: riskSignals.id,
        eventId: riskSignals.eventId,
        riskType: riskSignals.riskType,
        category: riskSignals.category,
        severity: riskSignals.severity,
        direction: riskSignals.direction,
        rationale: riskSignals.rationale,
      })
      .from(riskSignals)
      .where(eq(riskSignals.eventId, ev.id))
    )
  );

  return Response.json({
    article,
    entities: entityTags,
    events: articleEvents.map((ev, i) => ({
      ...ev,
      riskSignals: allSignals[i] ?? [],
    })),
  });
}
