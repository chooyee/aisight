import type { LoaderFunctionArgs } from "@react-router/node";
import { eq } from "drizzle-orm";
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
