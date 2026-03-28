import type { LoaderFunctionArgs } from "@react-router/node";
import { eq } from "drizzle-orm";
import { getDb } from "~/lib/db/client";
import { entities, relationships } from "~/lib/db/schema";

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const sector = url.searchParams.get("sector");

  const db = getDb();

  // Nodes: all entities (optionally filtered by sector)
  const entityRows = await db
    .select()
    .from(entities)
    .where(sector ? eq(entities.sector, sector) : undefined);

  // Edges: all relationships between those entities
  const relRows = await db.select().from(relationships);

  const nodeIds = new Set(entityRows.map((e) => e.id));

  const nodes = entityRows.map((e) => ({
    data: {
      id: e.id,
      label: e.name,
      type: e.type,
      sector: e.sector,
      country: e.country,
    },
  }));

  const edges = relRows
    .filter((r) => nodeIds.has(r.fromEntityId) && nodeIds.has(r.toEntityId))
    .map((r) => ({
      data: {
        id: r.id,
        source: r.fromEntityId,
        target: r.toEntityId,
        label: r.relationshipType,
        weight: r.weight,
      },
    }));

  return Response.json(
    { nodes, edges, entityCount: nodes.length, edgeCount: edges.length },
    { headers: { "Cache-Control": "max-age=60" } }
  );
}
