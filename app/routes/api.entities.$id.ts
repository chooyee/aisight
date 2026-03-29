import type { ActionFunctionArgs } from "react-router";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { getDb } from "~/lib/db/client";
import { entities, entityProfiles } from "~/lib/db/schema";

// PUT /api/entities/:id  — upsert entity basic fields + profile
export async function action({ request, params }: ActionFunctionArgs) {
  if (request.method !== "PUT") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const { id } = params;
  if (!id) return Response.json({ error: "Missing id" }, { status: 400 });

  const db = getDb();
  const [entity] = await db.select().from(entities).where(eq(entities.id, id));
  if (!entity) return Response.json({ error: "Entity not found" }, { status: 404 });

  const body = await request.json() as Record<string, string | null>;

  // Update basic entity fields
  await db
    .update(entities)
    .set({
      sector: body.sector ?? null,
      country: body.country ?? null,
    })
    .where(eq(entities.id, id));

  // Upsert profile
  const [existing] = await db
    .select({ id: entityProfiles.id })
    .from(entityProfiles)
    .where(eq(entityProfiles.entityId, id));

  const profileData = {
    aliases: body.aliases ?? null,
    description: body.description ?? null,
    website: body.website ?? null,
    notes: body.notes ?? null,
    dateOfBirth: body.dateOfBirth ?? null,
    nationality: body.nationality ?? null,
    gender: body.gender ?? null,
    registrationNo: body.registrationNo ?? null,
    incorporatedDate: body.incorporatedDate ?? null,
    jurisdiction: body.jurisdiction ?? null,
    listedExchange: body.listedExchange ?? null,
    listedDate: body.listedDate ?? null,
    updatedAt: new Date(),
  };

  if (existing) {
    await db.update(entityProfiles).set(profileData).where(eq(entityProfiles.id, existing.id));
  } else {
    await db.insert(entityProfiles).values({
      id: nanoid(),
      entityId: id,
      ...profileData,
    });
  }

  return Response.json({ ok: true });
}
