import type { ActionFunctionArgs } from "react-router";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { getDb } from "~/lib/db/client";
import { entities, entityAffiliations } from "~/lib/db/schema";

// POST  /api/entities/:id/affiliations  — create affiliation
// DELETE /api/entities/:id/affiliations — delete affiliation (body: { id })
export async function action({ request, params }: ActionFunctionArgs) {
  const { id: entityId } = params;
  if (!entityId) return Response.json({ error: "Missing entity id" }, { status: 400 });

  const db = getDb();

  // ── DELETE ────────────────────────────────────────────────────────────────
  if (request.method === "DELETE") {
    const body = await request.json() as { id: string };
    if (!body.id) return Response.json({ error: "Missing affiliation id" }, { status: 400 });

    await db
      .delete(entityAffiliations)
      .where(eq(entityAffiliations.id, body.id));

    return Response.json({ ok: true });
  }

  // ── POST ──────────────────────────────────────────────────────────────────
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const body = await request.json() as {
    relatedEntityId: string;
    affiliationType: string;
    role?: string | null;
    ownershipPct?: number | null;
    startDate?: string | null;
    endDate?: string | null;
    isCurrent?: boolean;
    source?: string;
    confidence?: number;
    notes?: string | null;
  };

  if (!body.relatedEntityId || !body.affiliationType) {
    return Response.json({ error: "relatedEntityId and affiliationType are required" }, { status: 400 });
  }

  // Verify both entities exist
  const [subject] = await db.select({ id: entities.id }).from(entities).where(eq(entities.id, entityId));
  const [related] = await db.select({ id: entities.id, name: entities.name, type: entities.type })
    .from(entities).where(eq(entities.id, body.relatedEntityId));

  if (!subject) return Response.json({ error: "Subject entity not found" }, { status: 404 });
  if (!related) return Response.json({ error: "Related entity not found" }, { status: 404 });

  const isCurrent = body.isCurrent ?? (body.endDate == null);

  const [inserted] = await db
    .insert(entityAffiliations)
    .values({
      id: nanoid(),
      entityId,
      relatedEntityId: body.relatedEntityId,
      affiliationType: body.affiliationType,
      role: body.role ?? null,
      ownershipPct: body.ownershipPct ?? null,
      startDate: body.startDate ?? null,
      endDate: isCurrent ? null : (body.endDate ?? null),
      isCurrent,
      source: (body.source ?? "manual") as "manual" | "llm_research",
      confidence: body.confidence ?? 1.0,
      notes: body.notes ?? null,
    })
    .returning();

  return Response.json({
    affiliation: {
      ...inserted,
      relatedName: related.name,
      relatedType: related.type,
      createdAt: inserted.createdAt.toISOString(),
      updatedAt: inserted.updatedAt.toISOString(),
    },
  });
}
