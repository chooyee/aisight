import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, Link, Form, useSearchParams } from "react-router";
import { like, eq, and } from "drizzle-orm";
import { getDb } from "~/lib/db/client";
import { entities, entityAffiliations } from "~/lib/db/schema";
import { AppShell } from "~/components/layout/AppShell";

const TYPE_COLOURS: Record<string, string> = {
  company: "#3b82f6",
  regulator: "#f59e0b",
  person: "#10b981",
  instrument: "#8b5cf6",
};

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const q = url.searchParams.get("q") ?? "";
  const type = url.searchParams.get("type") ?? "";

  const db = getDb();

  const conditions = [];
  if (q) conditions.push(like(entities.name, `%${q}%`));
  if (type) conditions.push(eq(entities.type, type));

  const entityRows = await db
    .select()
    .from(entities)
    .where(conditions.length === 0 ? undefined : conditions.length === 1 ? conditions[0] : and(...conditions))
    .limit(300);

  // Count affiliations per entity
  const affiliationRows = await db
    .select({ entityId: entityAffiliations.entityId })
    .from(entityAffiliations);

  const affiliationCounts = new Map<string, number>();
  for (const { entityId } of affiliationRows) {
    affiliationCounts.set(entityId, (affiliationCounts.get(entityId) ?? 0) + 1);
  }

  return {
    entities: entityRows.map((e) => ({
      ...e,
      firstSeenAt: e.firstSeenAt?.toISOString() ?? null,
      createdAt: e.createdAt.toISOString(),
      affiliationCount: affiliationCounts.get(e.id) ?? 0,
    })),
    total: entityRows.length,
  };
}

export default function EntitiesPage() {
  const { entities: entityList, total } = useLoaderData<typeof loader>();
  const [searchParams] = useSearchParams();

  return (
    <AppShell>
      <div className="p-6 max-w-6xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-semibold">Entities</h1>
            <p className="text-xs text-white/40 mt-0.5">{total} entities — click any row to edit profile &amp; affiliations</p>
          </div>
        </div>

        {/* Filters */}
        <Form method="get" className="flex gap-2 mb-4">
          <input
            name="q"
            defaultValue={searchParams.get("q") ?? ""}
            placeholder="Search by name…"
            className="flex-1 bg-[var(--color-surface-1)] border border-[var(--color-border)] rounded px-3 py-1.5 text-sm text-white/90 placeholder:text-white/30 focus:outline-none focus:border-[var(--color-accent)]"
          />
          <select
            name="type"
            defaultValue={searchParams.get("type") ?? ""}
            className="bg-[var(--color-surface-1)] border border-[var(--color-border)] rounded px-2 py-1.5 text-sm text-white/70"
          >
            <option value="">All Types</option>
            <option value="company">Company</option>
            <option value="person">Person</option>
            <option value="regulator">Regulator</option>
            <option value="instrument">Instrument</option>
          </select>
          <button
            type="submit"
            className="bg-[var(--color-accent)] text-white text-sm px-4 py-1.5 rounded hover:opacity-80 cursor-pointer"
          >
            Search
          </button>
          {(searchParams.get("q") || searchParams.get("type")) && (
            <Link
              to="/entities"
              className="text-sm px-3 py-1.5 rounded border border-[var(--color-border)] text-white/50 hover:text-white/80"
            >
              Clear
            </Link>
          )}
        </Form>

        {/* Table */}
        <div className="border border-[var(--color-border)] rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--color-border)] bg-[var(--color-surface-1)]">
                <th className="text-left px-4 py-2.5 text-white/50 font-medium">Name</th>
                <th className="text-left px-4 py-2.5 text-white/50 font-medium">Type</th>
                <th className="text-left px-4 py-2.5 text-white/50 font-medium">Sector</th>
                <th className="text-left px-4 py-2.5 text-white/50 font-medium">Country</th>
                <th className="text-center px-4 py-2.5 text-white/50 font-medium">Affiliations</th>
                <th className="px-4 py-2.5"></th>
              </tr>
            </thead>
            <tbody>
              {entityList.map((entity) => (
                <tr
                  key={entity.id}
                  className="border-b border-[var(--color-border)] last:border-0 hover:bg-white/3 transition-colors"
                >
                  <td className="px-4 py-2.5 font-medium">{entity.name}</td>
                  <td className="px-4 py-2.5">
                    <span
                      className="text-[11px] px-2 py-0.5 rounded font-medium capitalize"
                      style={{
                        backgroundColor: (TYPE_COLOURS[entity.type] ?? "#64748b") + "25",
                        color: TYPE_COLOURS[entity.type] ?? "#94a3b8",
                      }}
                    >
                      {entity.type}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-white/50 text-xs">{entity.sector ?? "—"}</td>
                  <td className="px-4 py-2.5 text-white/50 text-xs">{entity.country ?? "—"}</td>
                  <td className="px-4 py-2.5 text-center">
                    {entity.affiliationCount > 0 ? (
                      <span className="text-xs bg-[var(--color-accent)]/15 text-[var(--color-accent)] px-2 py-0.5 rounded-full">
                        {entity.affiliationCount}
                      </span>
                    ) : (
                      <span className="text-white/25 text-xs">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <Link
                      to={`/entities/${entity.id}`}
                      className="text-[var(--color-accent)] text-xs hover:underline"
                    >
                      Edit →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {entityList.length === 0 && (
            <div className="text-center py-12 text-white/30 text-sm">No entities found.</div>
          )}
        </div>
      </div>
    </AppShell>
  );
}
