import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, Link } from "react-router";
import { desc, gte, lte, and, eq, type SQL } from "drizzle-orm";
import { getDb } from "~/lib/db/client";
import { articles, articleEntities, entities, riskSignals, events, fiscalCalendars } from "~/lib/db/schema";
import { AppShell } from "~/components/layout/AppShell";
import { getFiscalQuartersForYear, type FiscalQuarter } from "~/lib/fiscal/quarters";

interface CalendarOption {
  entityName: string;
  yearStartMonth: number;
  quarterStartMonths: number[];
}

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const sector = url.searchParams.get("sector");
  const year = url.searchParams.get("year");
  const month = url.searchParams.get("month");
  const quarter = url.searchParams.get("quarter"); // e.g. "Q1"
  const entity = url.searchParams.get("entity");   // entity name for fiscal calendar

  const db = getDb();

  // Load fiscal calendars for the quarter filter dropdown
  const calendarRows = await db.select().from(fiscalCalendars).orderBy(fiscalCalendars.entityName);
  const calendars: CalendarOption[] = calendarRows.map((c) => ({
    entityName: c.entityName,
    yearStartMonth: c.yearStartMonth,
    quarterStartMonths: JSON.parse(c.quarterStartMonths) as number[],
  }));

  // Build filters
  const filters: SQL[] = [];
  if (sector) filters.push(eq(articles.sector, sector));

  // Fiscal quarter filter: entity + quarter + year → date range
  if (entity && quarter && year) {
    const cal = calendars.find((c) => c.entityName === entity);
    if (cal) {
      const qNum = parseInt(quarter.replace("Q", ""), 10);
      const quarters = getFiscalQuartersForYear(parseInt(year, 10), cal);
      const fq = quarters.find((q) => q.quarter === qNum);
      if (fq) {
        filters.push(gte(articles.publishedAt, fq.startDate));
        filters.push(lte(articles.publishedAt, fq.endDate));
      }
    }
  } else if (year && month) {
    // Year + Month filter
    const y = parseInt(year, 10);
    const m = parseInt(month, 10);
    filters.push(gte(articles.publishedAt, new Date(y, m - 1, 1)));
    filters.push(lte(articles.publishedAt, new Date(y, m, 0))); // last day of month
  } else if (year) {
    // Year only
    const y = parseInt(year, 10);
    filters.push(gte(articles.publishedAt, new Date(y, 0, 1)));
    filters.push(lte(articles.publishedAt, new Date(y, 11, 31)));
  } else {
    // Absolute date range
    if (from) filters.push(gte(articles.publishedAt, new Date(from)));
    if (to) filters.push(lte(articles.publishedAt, new Date(to)));
  }

  const rows = await db
    .select()
    .from(articles)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(articles.publishedAt))
    .limit(50);

  const articlesWithMeta = await Promise.all(
    rows.map(async (article) => {
      const tags = await db
        .select({ name: entities.name, type: entities.type })
        .from(articleEntities)
        .innerJoin(entities, eq(articleEntities.entityId, entities.id))
        .where(eq(articleEntities.articleId, article.id))
        .limit(5);

      const signals = await db
        .select({ riskType: riskSignals.riskType, severity: riskSignals.severity, direction: riskSignals.direction })
        .from(riskSignals)
        .innerJoin(events, eq(riskSignals.eventId, events.id))
        .where(eq(events.articleId, article.id))
        .limit(3);

      return { ...article, entities: tags, riskSignals: signals };
    })
  );

  const currentYear = new Date().getFullYear();
  const years = Array.from({ length: 5 }, (_, i) => currentYear - i);

  return {
    articles: articlesWithMeta,
    totalCount: articlesWithMeta.length,
    calendars,
    years,
    filters: { from, to, sector, year, month, quarter, entity },
  };
}

const SEVERITY_COLOUR: Record<string, string> = {
  high: "text-[var(--color-risk-high)] bg-[var(--color-risk-high)]/10",
  medium: "text-[var(--color-risk-medium)] bg-[var(--color-risk-medium)]/10",
  low: "text-[var(--color-risk-low)] bg-[var(--color-risk-low)]/10",
};

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

export default function Dashboard() {
  const { articles, totalCount, calendars, years, filters } = useLoaderData<typeof loader>();

  return (
    <AppShell>
      <div className="p-6 max-w-5xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-semibold">Intelligence Dashboard</h1>
            <p className="text-sm text-white/40 mt-0.5">{totalCount} articles</p>
          </div>
          <Link
            to="/chat"
            className="px-4 py-2 bg-[var(--color-accent)] text-white text-sm rounded-md hover:opacity-90 transition-opacity"
          >
            + New Scrape
          </Link>
        </div>

        {/* Filter bar — date range OR year/month/quarter */}
        <form method="get" className="mb-6 space-y-3">
          {/* Row 1: Year · Month · Sector */}
          <div className="flex gap-3 flex-wrap">
            <select
              name="year"
              defaultValue={filters.year ?? ""}
              className="px-3 py-1.5 text-sm bg-[var(--color-surface-1)] border border-[var(--color-border)] rounded-md text-white/80 focus:outline-none focus:border-[var(--color-accent)]"
            >
              <option value="">Year</option>
              {years.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>

            <select
              name="month"
              defaultValue={filters.month ?? ""}
              className="px-3 py-1.5 text-sm bg-[var(--color-surface-1)] border border-[var(--color-border)] rounded-md text-white/80 focus:outline-none focus:border-[var(--color-accent)]"
            >
              <option value="">Month</option>
              {MONTHS.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
            </select>

            <input
              type="text"
              name="sector"
              placeholder="Sector…"
              defaultValue={filters.sector ?? ""}
              className="px-3 py-1.5 text-sm bg-[var(--color-surface-1)] border border-[var(--color-border)] rounded-md text-white/80 focus:outline-none focus:border-[var(--color-accent)] w-36"
            />

            <button
              type="submit"
              className="px-4 py-1.5 text-sm bg-[var(--color-surface-2)] border border-[var(--color-border)] rounded-md text-white/70 hover:text-white transition-colors"
            >
              Filter
            </button>
          </div>

          {/* Row 2: Entity-specific fiscal quarter filter */}
          {calendars.length > 0 && (
            <div className="flex gap-3 flex-wrap items-center">
              <span className="text-xs text-white/40">Fiscal quarter:</span>
              <select
                name="entity"
                defaultValue={filters.entity ?? ""}
                className="px-3 py-1.5 text-sm bg-[var(--color-surface-1)] border border-[var(--color-border)] rounded-md text-white/80 focus:outline-none focus:border-[var(--color-accent)]"
              >
                <option value="">Entity…</option>
                {calendars.map((c) => <option key={c.entityName} value={c.entityName}>{c.entityName}</option>)}
              </select>

              <select
                name="quarter"
                defaultValue={filters.quarter ?? ""}
                className="px-3 py-1.5 text-sm bg-[var(--color-surface-1)] border border-[var(--color-border)] rounded-md text-white/80 focus:outline-none focus:border-[var(--color-accent)]"
              >
                <option value="">Quarter</option>
                <option value="Q1">Q1</option>
                <option value="Q2">Q2</option>
                <option value="Q3">Q3</option>
                <option value="Q4">Q4</option>
              </select>

              <span className="text-xs text-white/30">
                (requires Year above)
              </span>
            </div>
          )}

          {/* Row 3: Absolute date range fallback */}
          <details className="text-xs text-white/40">
            <summary className="cursor-pointer hover:text-white/60">Absolute date range…</summary>
            <div className="flex gap-3 mt-2">
              <input
                type="date"
                name="from"
                defaultValue={filters.from ?? ""}
                className="px-3 py-1.5 text-sm bg-[var(--color-surface-1)] border border-[var(--color-border)] rounded-md text-white/80 focus:outline-none focus:border-[var(--color-accent)]"
              />
              <span className="text-white/30 self-center">to</span>
              <input
                type="date"
                name="to"
                defaultValue={filters.to ?? ""}
                className="px-3 py-1.5 text-sm bg-[var(--color-surface-1)] border border-[var(--color-border)] rounded-md text-white/80 focus:outline-none focus:border-[var(--color-accent)]"
              />
            </div>
          </details>
        </form>

        {/* Article list */}
        {articles.length === 0 ? (
          <div className="text-center py-20 text-white/30">
            <p className="text-4xl mb-3">◈</p>
            <p>No articles yet. Use the Chat to trigger a scrape.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {articles.map((article) => (
              <article
                key={article.id}
                className="bg-[var(--color-surface-1)] border border-[var(--color-border)] rounded-lg p-4 hover:border-[var(--color-accent)]/40 transition-colors"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <a
                      href={article.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-medium text-white/90 hover:text-[var(--color-accent)] transition-colors line-clamp-2 text-sm"
                    >
                      {article.title ?? article.url}
                    </a>
                    <div className="flex flex-wrap gap-1.5 mt-2">
                      {article.entities.map((e) => (
                        <span
                          key={e.name}
                          className="px-2 py-0.5 text-xs rounded-full bg-[var(--color-surface-2)] text-white/60 border border-[var(--color-border)]"
                        >
                          {e.name}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="text-xs text-white/40">
                      {article.publishedAt
                        ? new Date(article.publishedAt).toLocaleDateString("en-MY", {
                            day: "numeric",
                            month: "short",
                            year: "numeric",
                          })
                        : "Unknown date"}
                    </p>
                    <div className="flex flex-col gap-1 mt-1 items-end">
                      {article.riskSignals.slice(0, 2).map((s, i) => (
                        <span
                          key={i}
                          className={`px-2 py-0.5 text-xs rounded-full ${SEVERITY_COLOUR[s.severity ?? "low"] ?? SEVERITY_COLOUR.low}`}
                        >
                          {s.riskType}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
                <p className="text-xs text-white/30 mt-2">
                  {article.source} · {article.language ?? "en"}
                </p>
              </article>
            ))}
          </div>
        )}
      </div>
    </AppShell>
  );
}
