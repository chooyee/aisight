import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { getDb } from "~/lib/db/client";
import { entities } from "~/lib/db/schema";

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const sector = url.searchParams.get("sector");
  const type = url.searchParams.get("type");

  const db = getDb();

  const rows = await db
    .select()
    .from(entities)
    .where(
      sector ? eq(entities.sector, sector) :
      type   ? eq(entities.type, type)     :
      undefined
    )
    .orderBy(entities.name);

  return Response.json({ entities: rows });
}

// POST /api/entities — create a new entity
export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const db = getDb();
  const body = await request.json() as { name: string; type?: string; sector?: string | null; country?: string | null };

  if (!body.name?.trim()) {
    return Response.json({ error: "name is required" }, { status: 400 });
  }

  const id = nanoid();
  const [inserted] = await db
    .insert(entities)
    .values({
      id,
      name: body.name.trim(),
      type: (body.type ?? "company") as "company" | "person" | "regulator" | "instrument",
      sector: body.sector ?? null,
      country: body.country ?? null,
    })
    .returning();

  return Response.json({ entity: inserted }, { status: 201 });
}
