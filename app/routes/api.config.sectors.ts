import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { getDb } from "~/lib/db/client";
import { sectors } from "~/lib/db/schema";

export async function loader(_: LoaderFunctionArgs) {
  const db = getDb();
  const rows = await db.select().from(sectors).orderBy(sectors.name);
  return Response.json({ sectors: rows });
}

export async function action({ request }: ActionFunctionArgs) {
  const db = getDb();

  if (request.method === "POST") {
    const body = await request.json() as { name: string; keywords?: string[] };
    if (!body.name?.trim()) return Response.json({ error: "name required" }, { status: 400 });
    const id = nanoid();
    await db.insert(sectors).values({
      id,
      name: body.name.trim(),
      keywords: JSON.stringify(body.keywords ?? []),
      active: true,
    });
    return Response.json({ id }, { status: 201 });
  }

  if (request.method === "PUT") {
    const body = await request.json() as { id: string; name?: string; keywords?: string[]; active?: boolean };
    if (!body.id) return Response.json({ error: "id required" }, { status: 400 });
    await db.update(sectors).set({
      ...(body.name !== undefined && { name: body.name }),
      ...(body.keywords !== undefined && { keywords: JSON.stringify(body.keywords) }),
      ...(body.active !== undefined && { active: body.active }),
    }).where(eq(sectors.id, body.id));
    return Response.json({ ok: true });
  }

  if (request.method === "DELETE") {
    const body = await request.json() as { id: string };
    if (!body.id) return Response.json({ error: "id required" }, { status: 400 });
    await db.delete(sectors).where(eq(sectors.id, body.id));
    return Response.json({ ok: true });
  }

  return new Response("Method Not Allowed", { status: 405 });
}
