import type { LoaderFunctionArgs } from "react-router";
import { desc, gte, lte, eq, and, type SQL } from "drizzle-orm";
import { getDb } from "~/lib/db/client";
import { articles, articleEntities, entities } from "~/lib/db/schema";

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const page = Math.max(1, Number(url.searchParams.get("page") ?? "1"));
  const limit = Math.min(50, Number(url.searchParams.get("limit") ?? "20"));
  const offset = (page - 1) * limit;
  const sector = url.searchParams.get("sector");
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");

  const db = getDb();

  const filters: SQL[] = [];
  if (sector) filters.push(eq(articles.sector, sector));
  if (from) filters.push(gte(articles.publishedAt, new Date(from)));
  if (to) filters.push(lte(articles.publishedAt, new Date(to)));

  const rows = await db
    .select()
    .from(articles)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(articles.publishedAt))
    .limit(limit)
    .offset(offset);

  // Attach entity tags for each article
  const articlesWithEntities = await Promise.all(
    rows.map(async (article) => {
      const tags = await db
        .select({ name: entities.name, type: entities.type })
        .from(articleEntities)
        .innerJoin(entities, eq(articleEntities.entityId, entities.id))
        .where(eq(articleEntities.articleId, article.id))
        .limit(10);
      return { ...article, entities: tags };
    })
  );

  return Response.json({ articles: articlesWithEntities, page, limit });
}
