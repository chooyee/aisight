import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, Link } from "react-router";
import { eq } from "drizzle-orm";
import { getDb } from "~/lib/db/client";
import { articles, articleEntities, entities, events, riskSignals } from "~/lib/db/schema";
import { AppShell } from "~/components/layout/AppShell";

export async function loader({ params }: LoaderFunctionArgs) {
  const { id } = params;
  if (!id) throw new Response("Not found", { status: 404 });

  const db = getDb();

  const [article] = await db.select().from(articles).where(eq(articles.id, id)).limit(1);
  if (!article) throw new Response("Not found", { status: 404 });

  const entityTags = await db
    .select({
      id: entities.id,
      name: entities.name,
      type: entities.type,
      country: entities.country,
      confidence: articleEntities.confidence,
      context: articleEntities.context,
    })
    .from(articleEntities)
    .innerJoin(entities, eq(articleEntities.entityId, entities.id))
    .where(eq(articleEntities.articleId, id));

  const articleEvents = await db
    .select()
    .from(events)
    .where(eq(events.articleId, id));

  const eventsWithSignals = await Promise.all(
    articleEvents.map(async (ev) => {
      const signals = await db
        .select()
        .from(riskSignals)
        .where(eq(riskSignals.eventId, ev.id));
      return { ...ev, riskSignals: signals };
    })
  );

  return { article, entities: entityTags, events: eventsWithSignals };
}

const ENTITY_TYPE_COLOUR: Record<string, string> = {
  company: "text-blue-300 border-blue-400/30 bg-blue-400/10",
  regulator: "text-purple-300 border-purple-400/30 bg-purple-400/10",
  person: "text-green-300 border-green-400/30 bg-green-400/10",
  instrument: "text-yellow-300 border-yellow-400/30 bg-yellow-400/10",
};

const SEVERITY_COLOUR: Record<string, string> = {
  high: "text-red-300 bg-red-400/10 border-red-400/30",
  medium: "text-amber-300 bg-amber-400/10 border-amber-400/30",
  low: "text-green-300 bg-green-400/10 border-green-400/30",
};

const DIRECTION_COLOUR: Record<string, string> = {
  positive: "text-green-400",
  negative: "text-red-400",
  neutral: "text-white/50",
};

export default function ArticleDetail() {
  const { article, entities, events } = useLoaderData<typeof loader>();

  const allSignals = events.flatMap((e) => e.riskSignals);
  const summary = events[0]?.description;

  return (
    <AppShell>
      <div className="p-6 max-w-4xl mx-auto">
        {/* Breadcrumb */}
        <div className="flex items-center gap-2 text-xs text-white/40 mb-6">
          <Link to="/dashboard" className="hover:text-white/70">Dashboard</Link>
          <span>/</span>
          <span className="text-white/60 truncate max-w-xs">{article.title ?? article.url}</span>
        </div>

        {/* Header */}
        <div className="mb-6">
          <h1 className="text-lg font-semibold text-white/90 leading-snug mb-2">
            {article.title ?? article.url}
          </h1>
          <div className="flex flex-wrap gap-3 text-xs text-white/40">
            <span>
              {article.publishedAt
                ? new Date(article.publishedAt).toLocaleDateString("en-MY", { day: "numeric", month: "long", year: "numeric" })
                : "Unknown publish date"}
            </span>
            <span>·</span>
            <span>Scraped {new Date(article.scrapedAt).toLocaleDateString("en-MY", { day: "numeric", month: "short", year: "numeric" })}</span>
            <span>·</span>
            <span className="uppercase tracking-wide">{article.source}</span>
            {article.language && <><span>·</span><span>{article.language}</span></>}
          </div>
          <a
            href={article.url}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-block text-xs text-[var(--color-accent)] hover:underline break-all"
          >
            {article.url}
          </a>
        </div>

        <div className="space-y-5">
          {/* Summary / Event description */}
          {summary && (
            <section className="bg-[var(--color-surface-1)] border border-[var(--color-border)] rounded-lg p-4">
              <h2 className="text-xs uppercase tracking-wide text-white/40 mb-2">Summary</h2>
              <p className="text-sm text-white/80 leading-relaxed">{summary}</p>
            </section>
          )}

          {/* Entities extracted */}
          <section className="bg-[var(--color-surface-1)] border border-[var(--color-border)] rounded-lg p-4">
            <h2 className="text-xs uppercase tracking-wide text-white/40 mb-3">
              Entities Extracted ({entities.length})
            </h2>
            {entities.length === 0 ? (
              <p className="text-sm text-white/30">No entities extracted.</p>
            ) : (
              <div className="space-y-2">
                {entities.map((ent) => (
                  <div key={ent.id} className="flex items-start gap-3">
                    <Link
                      to={`/entities/${ent.id}`}
                      className={`shrink-0 px-2 py-0.5 text-xs rounded border font-medium hover:opacity-80 transition-opacity ${ENTITY_TYPE_COLOUR[ent.type] ?? "text-white/60 border-white/20 bg-white/5"}`}
                    >
                      {ent.type}
                    </Link>
                    <div className="flex-1 min-w-0">
                      <Link
                        to={`/entities/${ent.id}`}
                        className="text-sm text-white/90 font-medium hover:text-[var(--color-accent)] transition-colors"
                      >
                        {ent.name}
                      </Link>
                      {ent.country && (
                        <span className="ml-2 text-xs text-white/40">{ent.country}</span>
                      )}
                      {ent.context && (
                        <p className="text-xs text-white/50 mt-0.5">{ent.context}</p>
                      )}
                    </div>
                    {ent.confidence != null && (
                      <span className="shrink-0 text-xs text-white/30">
                        {Math.round(ent.confidence * 100)}%
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Events */}
          {events.length > 0 && (
            <section className="bg-[var(--color-surface-1)] border border-[var(--color-border)] rounded-lg p-4">
              <h2 className="text-xs uppercase tracking-wide text-white/40 mb-3">
                Events ({events.length})
              </h2>
              <div className="space-y-3">
                {events.map((ev) => (
                  <div key={ev.id} className="border-l-2 border-[var(--color-accent)]/30 pl-3">
                    {ev.eventType && (
                      <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border border-[var(--color-accent)]/30 text-[var(--color-accent)]/70 bg-[var(--color-accent)]/5">
                        {ev.eventType}
                      </span>
                    )}
                    {ev.description && (
                      <p className="text-sm text-white/80 mt-1 leading-relaxed">{ev.description}</p>
                    )}
                    {ev.occurredAt && (
                      <p className="text-xs text-white/40 mt-1">
                        {new Date(ev.occurredAt).toLocaleDateString("en-MY", { day: "numeric", month: "short", year: "numeric" })}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Risk signals */}
          {allSignals.length > 0 && (
            <section className="bg-[var(--color-surface-1)] border border-[var(--color-border)] rounded-lg p-4">
              <h2 className="text-xs uppercase tracking-wide text-white/40 mb-3">
                Risk Signals ({allSignals.length})
              </h2>
              <div className="space-y-3">
                {allSignals.map((sig) => (
                  <div key={sig.id} className="flex items-start gap-3">
                    <div className="shrink-0 flex flex-col gap-1 items-start">
                      {sig.severity && (
                        <span className={`text-xs px-2 py-0.5 rounded border font-medium ${SEVERITY_COLOUR[sig.severity] ?? SEVERITY_COLOUR.low}`}>
                          {sig.severity}
                        </span>
                      )}
                      {sig.direction && (
                        <span className={`text-xs font-medium ${DIRECTION_COLOUR[sig.direction] ?? ""}`}>
                          {sig.direction}
                        </span>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-white/90 font-medium">{sig.riskType}</p>
                      {sig.category && (
                        <p className="text-xs text-white/40 mt-0.5">{sig.category}</p>
                      )}
                      {sig.rationale && (
                        <p className="text-xs text-white/60 mt-1 leading-relaxed">{sig.rationale}</p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* No data fallback */}
          {!summary && entities.length === 0 && events.length === 0 && (
            <div className="text-center py-12 text-white/30 text-sm">
              No extracted data for this article yet.
            </div>
          )}
        </div>
      </div>
    </AppShell>
  );
}
