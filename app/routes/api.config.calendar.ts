import type { ActionFunctionArgs, LoaderFunctionArgs } from "@react-router/node";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { getDb } from "~/lib/db/client";
import { fiscalCalendars } from "~/lib/db/schema";

export async function loader(_: LoaderFunctionArgs) {
  const db = getDb();
  const rows = await db.select().from(fiscalCalendars).orderBy(fiscalCalendars.entityName);
  return Response.json({ calendars: rows });
}

export async function action({ request }: ActionFunctionArgs) {
  const db = getDb();

  if (request.method === "POST") {
    const body = await request.json() as {
      entityName: string;
      yearStartMonth: number;
      quarterStartMonths: number[];
    };
    if (!body.entityName?.trim()) return Response.json({ error: "entityName required" }, { status: 400 });
    const id = nanoid();
    await db.insert(fiscalCalendars).values({
      id,
      entityName: body.entityName.trim(),
      yearStartMonth: body.yearStartMonth ?? 1,
      quarterStartMonths: JSON.stringify(body.quarterStartMonths ?? [1, 4, 7, 10]),
    });
    return Response.json({ id }, { status: 201 });
  }

  if (request.method === "PUT") {
    const body = await request.json() as { id: string; yearStartMonth?: number; quarterStartMonths?: number[] };
    if (!body.id) return Response.json({ error: "id required" }, { status: 400 });
    await db.update(fiscalCalendars).set({
      ...(body.yearStartMonth !== undefined && { yearStartMonth: body.yearStartMonth }),
      ...(body.quarterStartMonths !== undefined && { quarterStartMonths: JSON.stringify(body.quarterStartMonths) }),
    }).where(eq(fiscalCalendars.id, body.id));
    return Response.json({ ok: true });
  }

  if (request.method === "DELETE") {
    const body = await request.json() as { id: string };
    if (!body.id) return Response.json({ error: "id required" }, { status: 400 });
    await db.delete(fiscalCalendars).where(eq(fiscalCalendars.id, body.id));
    return Response.json({ ok: true });
  }

  return new Response("Method Not Allowed", { status: 405 });
}
