import type { ActionFunctionArgs, LoaderFunctionArgs } from "@react-router/node";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { getDb } from "~/lib/db/client";
import { extractionItems } from "~/lib/db/schema";

export async function loader(_: LoaderFunctionArgs) {
  const db = getDb();
  const rows = await db.select().from(extractionItems).orderBy(extractionItems.label);
  return Response.json({ items: rows });
}

export async function action({ request }: ActionFunctionArgs) {
  const db = getDb();

  if (request.method === "POST") {
    const body = await request.json() as { label: string; category?: string; prompt: string };
    if (!body.label?.trim() || !body.prompt?.trim()) {
      return Response.json({ error: "label and prompt required" }, { status: 400 });
    }
    const id = nanoid();
    await db.insert(extractionItems).values({
      id,
      label: body.label.trim(),
      category: body.category,
      prompt: body.prompt,
      active: true,
    });
    return Response.json({ id }, { status: 201 });
  }

  if (request.method === "PUT") {
    const body = await request.json() as { id: string; label?: string; category?: string; prompt?: string; active?: boolean };
    if (!body.id) return Response.json({ error: "id required" }, { status: 400 });
    await db.update(extractionItems).set({
      ...(body.label !== undefined && { label: body.label }),
      ...(body.category !== undefined && { category: body.category }),
      ...(body.prompt !== undefined && { prompt: body.prompt }),
      ...(body.active !== undefined && { active: body.active }),
    }).where(eq(extractionItems.id, body.id));
    return Response.json({ ok: true });
  }

  if (request.method === "DELETE") {
    const body = await request.json() as { id: string };
    if (!body.id) return Response.json({ error: "id required" }, { status: 400 });
    await db.delete(extractionItems).where(eq(extractionItems.id, body.id));
    return Response.json({ ok: true });
  }

  return new Response("Method Not Allowed", { status: 405 });
}
