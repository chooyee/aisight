import type { LoaderFunctionArgs } from "@react-router/node";
import { useLoaderData, useSearchParams } from "react-router";
import { useState, useEffect, useRef, useCallback, type FormEvent } from "react";
import { eq, and, or, gte, lt, isNull, inArray } from "drizzle-orm";
import { getDb } from "~/lib/db/client";
import { entities, relationships, events, articleEntities, articles, entityAffiliations } from "~/lib/db/schema";
import { AppShell } from "~/components/layout/AppShell";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

// ── Colour maps ──────────────────────────────────────────────────────────────

const TYPE_COLOURS: Record<string, string> = {
  company: "#3b82f6",
  regulator: "#f59e0b",
  person: "#10b981",
  instrument: "#8b5cf6",
};

const EVENT_COLOURS: Record<string, string> = {
  regulation: "#f97316",
  enforcement: "#ef4444",
  merger_acquisition: "#8b5cf6",
  earnings: "#22c55e",
  risk_event: "#ef4444",
  policy_change: "#eab308",
  appointment: "#06b6d4",
  other: "#6b7280",
};

// ── Types ────────────────────────────────────────────────────────────────────

interface EntityNodeData {
  id: string;
  label: string;
  nodeType: "entity";
  entityType: string;
  sector: string | null;
  country: string | null;
}

interface EventNodeData {
  id: string;
  label: string;
  nodeType: "event";
  eventType: string;
  occurredAt: string | null;
  articleTitle: string | null;
  articleUrl: string | null;
  description: string | null;
}

type NodeData = EntityNodeData | EventNodeData;

interface EdgeData {
  id: string;
  source: string;
  target: string;
  label: string;
  edgeType: "relationship" | "involvement" | "affiliation";
  weight?: number | null;
  isCurrent?: boolean;
  affiliationType?: string;
  ownershipPct?: number | null;
}

interface GraphNode {
  data: NodeData;
}

interface GraphEdge {
  data: EdgeData;
}

// ── Loader ───────────────────────────────────────────────────────────────────

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const sector = url.searchParams.get("sector");
  const year = url.searchParams.get("year");
  const month = url.searchParams.get("month");

  const db = getDb();

  // ── Step 1: Build the time filter ─────────────────────────────────────────
  // occurredAt can be NULL when the LLM couldn't parse a date from the article.
  // Fallback: if occurredAt IS NULL, use the article's publishedAt instead.
  let timeFilter: ReturnType<typeof or> | undefined;
  if (year) {
    const y = parseInt(year, 10);
    if (!isNaN(y)) {
      let start: Date;
      let end: Date;
      if (month) {
        const m = parseInt(month, 10);
        if (!isNaN(m) && m >= 1 && m <= 12) {
          start = new Date(y, m - 1, 1);
          end = new Date(y, m, 1);
        } else {
          start = new Date(y, 0, 1);
          end = new Date(y + 1, 0, 1);
        }
      } else {
        start = new Date(y, 0, 1);
        end = new Date(y + 1, 0, 1);
      }
      timeFilter = or(
        and(gte(events.occurredAt, start), lt(events.occurredAt, end)),
        and(isNull(events.occurredAt), gte(articles.publishedAt, start), lt(articles.publishedAt, end))
      );
    }
  }

  // ── Step 2: Fetch events (time-filtered) ──────────────────────────────────
  const eventRows = await db
    .select({
      id: events.id,
      articleId: events.articleId,
      description: events.description,
      eventType: events.eventType,
      occurredAt: events.occurredAt,
      articleTitle: articles.title,
      articleUrl: articles.url,
    })
    .from(events)
    .leftJoin(articles, eq(events.articleId, articles.id))
    .where(timeFilter);

  const eventIds = new Set(eventRows.map((e) => e.id));

  // ── Step 3: Derive which entities are relevant to the filtered events ──────
  // When a time filter is active, only show entities that appear in at least
  // one article that has a matching event. This prevents orphaned entity nodes.
  const aeRows = await db.select().from(articleEntities);

  let activeEntityIds: Set<string> | null = null;
  if (timeFilter) {
    const filteredArticleIds = new Set(eventRows.map((e) => e.articleId));
    activeEntityIds = new Set(
      aeRows
        .filter((ae) => filteredArticleIds.has(ae.articleId))
        .map((ae) => ae.entityId)
    );
  }

  // ── Step 3b: Affiliation data + temporal entity expansion ─────────────────
  // Helper: was an affiliation active during a given year?
  function affActiveInYear(
    aff: { startDate: string | null; endDate: string | null; isCurrent: boolean },
    y: number
  ): boolean {
    const s = aff.startDate ? parseInt(aff.startDate.slice(0, 4)) : null;
    const e = aff.endDate ? parseInt(aff.endDate.slice(0, 4)) : null;
    if (s !== null && s > y) return false;
    if (e !== null && e < y) return false;
    return true;
  }

  const allAffRows = await db.select().from(entityAffiliations);

  // The year of the active time filter (null = no filter)
  const filterYear = year ? parseInt(year, 10) : null;

  // When a year filter is active, expand activeEntityIds by pulling in every
  // person/entity that had an active affiliation with an already-included entity
  // during that year. This makes the CEO of a company appear in the 2017 graph
  // even if they have no direct news article from 2017.
  if (filterYear !== null && activeEntityIds) {
    for (const a of allAffRows) {
      if (!affActiveInYear(a, filterYear)) continue;
      if (activeEntityIds.has(a.entityId) && !activeEntityIds.has(a.relatedEntityId)) {
        activeEntityIds.add(a.relatedEntityId);
      } else if (activeEntityIds.has(a.relatedEntityId) && !activeEntityIds.has(a.entityId)) {
        activeEntityIds.add(a.entityId);
      }
    }
  }

  // ── Step 4: Fetch entities ────────────────────────────────────────────────
  // • Time filter active → fetch exactly the expanded active set; bounded by
  //   events + affiliations in the period so no extra limit needed.
  // • No filter → cap at 200 to keep the initial graph manageable.
  const allEntityRows = activeEntityIds && activeEntityIds.size > 0
    ? await db.select().from(entities).where(inArray(entities.id, [...activeEntityIds]))
    : activeEntityIds // activeEntityIds is an empty set — no entities match
      ? []
      : await db
          .select()
          .from(entities)
          .where(sector ? eq(entities.sector, sector) : undefined)
          .limit(200);

  const entityRows = allEntityRows;
  const nodeIds = new Set(entityRows.map((e) => e.id));

  const entityNodes: GraphNode[] = entityRows.map((e) => ({
    data: {
      id: e.id,
      label: e.name,
      nodeType: "entity" as const,
      entityType: e.type,
      sector: e.sector,
      country: e.country,
    },
  }));

  const eventNodes: GraphNode[] = eventRows.map((e) => ({
    data: {
      id: e.id,
      label: e.description?.slice(0, 60) ?? e.eventType ?? "Event",
      nodeType: "event" as const,
      eventType: e.eventType ?? "other",
      occurredAt: e.occurredAt?.toISOString() ?? null,
      articleTitle: e.articleTitle ?? null,
      articleUrl: e.articleUrl ?? null,
      description: e.description ?? null,
    },
  }));

  // ── Step 5: Relationship edges (entity↔entity, AI-extracted) ─────────────
  const relRows = await db.select().from(relationships);
  const relEdges: GraphEdge[] = relRows
    .filter((r) => nodeIds.has(r.fromEntityId) && nodeIds.has(r.toEntityId))
    .map((r) => ({
      data: {
        id: r.id,
        source: r.fromEntityId,
        target: r.toEntityId,
        label: r.relationshipType,
        edgeType: "relationship" as const,
        weight: r.weight,
      },
    }));

  // ── Step 5b: Affiliation edges (time-filtered when year is set) ───────────
  // When year filter active: show only affiliations that were active that year,
  // and mark isCurrent=true if active in that year (drives teal vs dotted style).
  // When no filter: show all affiliations, use stored isCurrent value.
  const affiliationEdges: GraphEdge[] = allAffRows
    .filter((a) => {
      if (!nodeIds.has(a.entityId) || !nodeIds.has(a.relatedEntityId)) return false;
      if (filterYear !== null) return affActiveInYear(a, filterYear);
      return true;
    })
    .map((a) => {
      const activeInFilter = filterYear !== null ? affActiveInYear(a, filterYear) : a.isCurrent;
      const label = a.role
        ? activeInFilter ? a.role : `${a.role} (past)`
        : a.affiliationType;
      return {
        data: {
          id: `aff_${a.id}`,
          source: a.entityId,
          target: a.relatedEntityId,
          label,
          edgeType: "affiliation" as const,
          isCurrent: activeInFilter,
          affiliationType: a.affiliationType,
          ownershipPct: a.ownershipPct,
        },
      };
    });

  // ── Step 6: Involvement edges (entity↔event via shared article) ───────────

  const articleToEntities = new Map<string, Set<string>>();
  for (const ae of aeRows) {
    if (!nodeIds.has(ae.entityId)) continue;
    let set = articleToEntities.get(ae.articleId);
    if (!set) {
      set = new Set();
      articleToEntities.set(ae.articleId, set);
    }
    set.add(ae.entityId);
  }

  const articleToEvents = new Map<string, Set<string>>();
  for (const ev of eventRows) {
    if (!eventIds.has(ev.id)) continue;
    let set = articleToEvents.get(ev.articleId);
    if (!set) {
      set = new Set();
      articleToEvents.set(ev.articleId, set);
    }
    set.add(ev.id);
  }

  const involvementEdges: GraphEdge[] = [];
  const seenPairs = new Set<string>();
  for (const [articleId, entIds] of articleToEntities) {
    const evIds = articleToEvents.get(articleId);
    if (!evIds) continue;
    for (const entityId of entIds) {
      for (const eventId of evIds) {
        const pairKey = `${entityId}:${eventId}`;
        if (seenPairs.has(pairKey)) continue;
        seenPairs.add(pairKey);
        involvementEdges.push({
          data: {
            id: `inv_${entityId}_${eventId}`,
            source: entityId,
            target: eventId,
            label: "involved_in",
            edgeType: "involvement",
          },
        });
      }
    }
  }

  const nodes = [...entityNodes, ...eventNodes];
  const edges = [...relEdges, ...affiliationEdges, ...involvementEdges];

  return {
    nodes,
    edges,
    entityCount: entityNodes.length,
    eventCount: eventNodes.length,
    edgeCount: edges.length,
  };
}

// ── Graph Canvas ─────────────────────────────────────────────────────────────

function GraphCanvas({
  nodes,
  edges,
  onNodeClick,
  cyInstanceRef,
  highlightIds,
}: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  onNodeClick: (data: NodeData) => void;
  cyInstanceRef?: React.MutableRefObject<unknown>;
  highlightIds?: string[];
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<unknown>(null);

  useEffect(() => {
    if (!containerRef.current || nodes.length === 0) return;
    let destroyed = false;

    import("cytoscape").then(({ default: cytoscape }) => {
      if (destroyed || !containerRef.current) return;
      const cy = cytoscape({
        container: containerRef.current,
        elements: { nodes, edges },
        style: [
          // Entity nodes: circles
          {
            selector: "node[nodeType='entity']",
            style: {
              label: "data(label)",
              shape: "ellipse",
              "font-size": 11,
              color: "#e2e8f0",
              "text-wrap": "wrap" as const,
              "text-max-width": "80px",
              "background-color": (ele: { data: (k: string) => string }) =>
                TYPE_COLOURS[ele.data("entityType")] ?? "#64748b",
              width: 32,
              height: 32,
              "border-width": 1.5,
              "border-color": "#ffffff20",
            },
          },
          // Event nodes: diamonds
          {
            selector: "node[nodeType='event']",
            style: {
              label: "data(label)",
              shape: "diamond",
              "font-size": 9,
              color: "#e2e8f0",
              "text-wrap": "wrap" as const,
              "text-max-width": "70px",
              "background-color": (ele: { data: (k: string) => string }) =>
                EVENT_COLOURS[ele.data("eventType")] ?? "#6b7280",
              width: 24,
              height: 24,
              "border-width": 1,
              "border-color": "#ffffff20",
            },
          },
          // Relationship edges: solid
          {
            selector: "edge[edgeType='relationship']",
            style: {
              label: "data(label)",
              "font-size": 9,
              color: "#94a3b8",
              "curve-style": "bezier" as const,
              "target-arrow-shape": "triangle" as const,
              "line-color": "#334155",
              "target-arrow-color": "#334155",
              width: 1.5,
            },
          },
          // Involvement edges: dashed (entity↔event)
          {
            selector: "edge[edgeType='involvement']",
            style: {
              label: "",
              "curve-style": "bezier" as const,
              "target-arrow-shape": "triangle" as const,
              "line-color": "#475569",
              "target-arrow-color": "#475569",
              "line-style": "dashed" as const,
              width: 1,
            },
          },
          // Affiliation edges: current = solid teal, past = dotted grey
          {
            selector: "edge[edgeType='affiliation'][?isCurrent]",
            style: {
              label: "data(label)",
              "font-size": 8,
              color: "#5eead4",
              "curve-style": "bezier" as const,
              "target-arrow-shape": "triangle" as const,
              "line-color": "#14b8a6",
              "target-arrow-color": "#14b8a6",
              width: 2,
              "text-background-color": "#0f172a",
              "text-background-opacity": 0.7,
              "text-background-padding": "2px",
            },
          },
          {
            selector: "edge[edgeType='affiliation'][!isCurrent]",
            style: {
              label: "data(label)",
              "font-size": 8,
              color: "#64748b",
              "curve-style": "bezier" as const,
              "target-arrow-shape": "triangle" as const,
              "line-color": "#475569",
              "target-arrow-color": "#475569",
              "line-style": "dotted" as const,
              width: 1.5,
              "text-background-color": "#0f172a",
              "text-background-opacity": 0.7,
              "text-background-padding": "2px",
            },
          },
          // Selected state
          {
            selector: "node:selected",
            style: { "border-width": 3, "border-color": "#6366f1" },
          },
          // Highlighted by chat search
          {
            selector: "node.highlighted",
            style: {
              "border-width": 3,
              "border-color": "#facc15",
              "overlay-color": "#facc15",
              "overlay-opacity": 0.15,
            },
          },
        ],
        layout: { name: "cose", animate: false, padding: 40 } as never,
      });
      // Apply initial highlights (matched search nodes)
      if (highlightIds?.length) {
        for (const id of highlightIds) {
          cy.nodes(`#${id}`).addClass("highlighted");
        }
      }

      cy.on("tap", "node", (evt) => {
        const node = evt.target;
        const d = node.data();
        onNodeClick(d as NodeData);
      });
      cyRef.current = cy;
      if (cyInstanceRef) cyInstanceRef.current = cy;
    });

    return () => {
      destroyed = true;
      if (cyRef.current) {
        (cyRef.current as { destroy: () => void }).destroy();
        cyRef.current = null;
      }
    };
  }, [nodes, edges, onNodeClick, highlightIds]);

  return <div ref={containerRef} className="w-full h-full" />;
}

// ── Legend (collapsible overlay) ──────────────────────────────────────────────

function Legend() {
  const [open, setOpen] = useState(false);

  return (
    <div className="absolute bottom-3 left-3 bg-[var(--color-surface-1)]/90 backdrop-blur border border-[var(--color-border)] rounded-lg text-xs z-10">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 w-full px-3 py-1.5 font-medium text-white/60 cursor-pointer hover:text-white/90"
      >
        <span className="text-[10px]">{open ? "▾" : "▸"}</span>
        <span>Legend</span>
      </button>

      {open && (
        <div className="px-3 pb-2 border-t border-[var(--color-border)] pt-2 space-y-1.5">
          <div className="flex flex-wrap gap-x-2.5 gap-y-0.5">
            {Object.entries(TYPE_COLOURS).map(([type, color]) => (
              <span key={type} className="flex items-center gap-1">
                <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: color }} />
                <span className="text-white/50 capitalize text-[10px]">{type}</span>
              </span>
            ))}
          </div>
          <div className="flex flex-wrap gap-x-2.5 gap-y-0.5">
            {Object.entries(EVENT_COLOURS).map(([type, color]) => (
              <span key={type} className="flex items-center gap-1">
                <span className="inline-block w-2 h-2" style={{ backgroundColor: color, transform: "rotate(45deg)" }} />
                <span className="text-white/50 capitalize text-[10px]">{type.replace(/_/g, " ")}</span>
              </span>
            ))}
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-0.5">
            <span className="flex items-center gap-1">
              <span className="inline-block w-4 h-0 border-t border-[#334155]" />
              <span className="text-white/50 text-[10px]">Relationship</span>
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block w-4 h-0 border-t border-dashed border-[#475569]" />
              <span className="text-white/50 text-[10px]">Involvement</span>
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block w-4 h-0 border-t-2 border-[#14b8a6]" />
              <span className="text-white/50 text-[10px]">Affiliation (current)</span>
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block w-4 h-0 border-t border-dotted border-[#475569]" />
              <span className="text-white/50 text-[10px]">Affiliation (past)</span>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Chat message type ────────────────────────────────────────────────────────

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  context?: {
    entitiesFound: number;
    eventsFound: number;
    affiliationsFound: number;
    relationshipsFound: number;
    riskSignalsFound: number;
    webResultsUsed: number;
  };
  highlightEntityIds?: string[];
  highlightEventIds?: string[];
}

// ── Chat Panel ───────────────────────────────────────────────────────────────

function ChatPanel({
  onSearchResult,
}: {
  onSearchResult: (
    entityIds: string[],
    eventIds: string[],
    subgraph: { nodes: GraphNode[]; edges: GraphEdge[] } | null
  ) => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [webSearch, setWebSearch] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const q = input.trim();
    if (!q || loading) return;

    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: q }]);
    setLoading(true);

    try {
      const res = await fetch("/api/graph/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q, enableWebSearch: webSearch }),
      });
      const data = await res.json();

      if (data.error) {
        setMessages((prev) => [...prev, { role: "assistant", content: `Error: ${data.error}` }]);
      } else {
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: data.answer,
            context: data.context,
            highlightEntityIds: data.highlightEntityIds,
            highlightEventIds: data.highlightEventIds,
          },
        ]);
        onSearchResult(
          data.highlightEntityIds ?? [],
          data.highlightEventIds ?? [],
          data.subgraph ?? null
        );
      }
    } catch {
      setMessages((prev) => [...prev, { role: "assistant", content: "Failed to reach the server." }]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Chat messages */}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-3 py-2 space-y-2">
        {messages.length === 0 && (
          <div className="text-white/25 text-xs text-center mt-8 space-y-1">
            <p className="text-lg">&#x1F50D;</p>
            <p>Ask about entities, events,</p>
            <p>or risks in the graph</p>
          </div>
        )}
        {messages.map((msg, i) => (
          <div key={i} className={msg.role === "user" ? "flex justify-end" : ""}>
            <div
              className={`rounded-lg px-3 py-2 text-xs max-w-full ${
                msg.role === "user"
                  ? "bg-[var(--color-accent)] text-white ml-6"
                  : "bg-[var(--color-surface-1)] text-white/80 mr-2"
              }`}
            >
              {msg.role === "user" ? (
                <div className="whitespace-pre-wrap break-words">{msg.content}</div>
              ) : (
                <Markdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    p: ({ children }) => <p className="mb-1.5 last:mb-0 leading-relaxed">{children}</p>,
                    ul: ({ children }) => <ul className="list-disc list-inside mb-1.5 space-y-0.5 pl-1">{children}</ul>,
                    ol: ({ children }) => <ol className="list-decimal list-inside mb-1.5 space-y-0.5 pl-1">{children}</ol>,
                    li: ({ children }) => <li className="leading-relaxed">{children}</li>,
                    strong: ({ children }) => <strong className="font-semibold text-white/95">{children}</strong>,
                    em: ({ children }) => <em className="italic text-white/70">{children}</em>,
                    code: ({ children, className }) => {
                      const isBlock = className?.startsWith("language-");
                      return isBlock ? (
                        <code className="block bg-black/30 rounded p-2 mt-1 mb-1.5 text-[10px] font-mono text-white/70 whitespace-pre-wrap overflow-x-auto">{children}</code>
                      ) : (
                        <code className="bg-black/30 rounded px-1 py-0.5 text-[10px] font-mono text-white/70">{children}</code>
                      );
                    },
                    pre: ({ children }) => <pre className="mb-1.5">{children}</pre>,
                    blockquote: ({ children }) => (
                      <blockquote className="border-l-2 border-white/20 pl-2 italic text-white/50 mb-1.5">{children}</blockquote>
                    ),
                    h1: ({ children }) => <p className="font-semibold text-white/90 mb-1">{children}</p>,
                    h2: ({ children }) => <p className="font-semibold text-white/90 mb-1">{children}</p>,
                    h3: ({ children }) => <p className="font-medium text-white/80 mb-1">{children}</p>,
                    a: ({ href, children }) => (
                      <a href={href} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 underline">{children}</a>
                    ),
                    table: ({ children }) => (
                      <div className="overflow-x-auto mb-1.5">
                        <table className="w-full text-[10px] border-collapse">{children}</table>
                      </div>
                    ),
                    th: ({ children }) => <th className="border border-white/10 px-2 py-1 bg-white/5 font-medium text-left">{children}</th>,
                    td: ({ children }) => <td className="border border-white/10 px-2 py-1">{children}</td>,
                    hr: () => <hr className="border-white/10 my-1.5" />,
                  }}
                >
                  {msg.content}
                </Markdown>
              )}
              {msg.context && (
                <div className="flex gap-2 mt-1.5 pt-1.5 border-t border-white/10 text-[10px] text-white/40 flex-wrap">
                  {msg.context.entitiesFound > 0 && <span>{msg.context.entitiesFound} entities</span>}
                  {msg.context.eventsFound > 0 && <span>{msg.context.eventsFound} events</span>}
                  {msg.context.webResultsUsed > 0 && <span>{msg.context.webResultsUsed} web</span>}
                </div>
              )}
            </div>
          </div>
        ))}
        {loading && (
          <div className="bg-[var(--color-surface-1)] rounded-lg px-3 py-2 text-xs text-white/40 mr-2 animate-pulse">
            Thinking...
          </div>
        )}
      </div>

      {/* Input */}
      <div className="border-t border-[var(--color-border)] p-2 space-y-1.5">
        <form onSubmit={handleSubmit} className="flex gap-1.5">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask about the graph..."
            disabled={loading}
            className="flex-1 bg-[var(--color-surface-1)] border border-[var(--color-border)] rounded px-2 py-1.5 text-xs text-white/90 placeholder:text-white/30 focus:outline-none focus:border-[var(--color-accent)] disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={loading || !input.trim()}
            className="bg-[var(--color-accent)] hover:bg-[var(--color-accent)]/80 text-white text-xs px-3 py-1.5 rounded disabled:opacity-40 cursor-pointer shrink-0"
          >
            Send
          </button>
        </form>
        <label className="flex items-center gap-1.5 text-[10px] text-white/40 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={webSearch}
            onChange={(e) => setWebSearch(e.target.checked)}
            className="w-3 h-3 rounded accent-[var(--color-accent)]"
          />
          Include web search
        </label>
      </div>
    </div>
  );
}

// ── Node Detail Panel ────────────────────────────────────────────────────────

function NodeDetail({ node, onDismiss }: { node: NodeData; onDismiss: () => void }) {
  return (
    <div className="px-3 py-2 text-xs space-y-1">
      {node.nodeType === "entity" ? (
        <>
          <div className="flex items-center justify-between">
            <span
              className="text-[10px] uppercase tracking-wide font-medium px-1.5 py-0.5 rounded"
              style={{ backgroundColor: (TYPE_COLOURS[node.entityType] ?? "#64748b") + "30", color: TYPE_COLOURS[node.entityType] ?? "#94a3b8" }}
            >
              {node.entityType}
            </span>
            <button onClick={onDismiss} className="text-white/30 hover:text-white/60 cursor-pointer text-[10px]">&#x2715;</button>
          </div>
          <p className="font-medium text-sm">{node.label}</p>
          {node.sector && <p className="text-white/40">Sector: {node.sector}</p>}
          {node.country && <p className="text-white/40">Country: {node.country}</p>}
        </>
      ) : (
        <>
          <div className="flex items-center justify-between">
            <span
              className="text-[10px] uppercase tracking-wide font-medium px-1.5 py-0.5 rounded"
              style={{ backgroundColor: (EVENT_COLOURS[node.eventType] ?? "#6b7280") + "30", color: EVENT_COLOURS[node.eventType] ?? "#94a3b8" }}
            >
              {node.eventType?.replace(/_/g, " ")}
            </span>
            <button onClick={onDismiss} className="text-white/30 hover:text-white/60 cursor-pointer text-[10px]">&#x2715;</button>
          </div>
          <p className="font-medium text-sm">{node.label}</p>
          {node.occurredAt && (
            <p className="text-white/40">Date: {new Date(node.occurredAt).toLocaleDateString()}</p>
          )}
          {node.articleTitle && (
            <p className="text-white/40">
              Article:{" "}
              {node.articleUrl ? (
                <a href={node.articleUrl} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 underline">
                  {node.articleTitle}
                </a>
              ) : (
                node.articleTitle
              )}
            </p>
          )}
          {!node.articleTitle && node.articleUrl && (
            <a href={node.articleUrl} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 underline block">
              View source article &#x2192;
            </a>
          )}
          {node.description && (
            <p className="text-white/40 mt-1 line-clamp-4">{node.description}</p>
          )}
        </>
      )}
    </div>
  );
}

// ── Month names ──────────────────────────────────────────────────────────────

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

// ── Page component ───────────────────────────────────────────────────────────

export default function GraphPage() {
  const loaderData = useLoaderData<typeof loader>();
  const [displayNodes, setDisplayNodes] = useState(loaderData.nodes);
  const [displayEdges, setDisplayEdges] = useState(loaderData.edges);
  const [highlightIds, setHighlightIds] = useState<string[]>([]);
  const [searchActive, setSearchActive] = useState(false);
  const [selected, setSelected] = useState<NodeData | null>(null);
  const [mounted, setMounted] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(320);
  const [searchParams, setSearchParams] = useSearchParams();
  const cyRef = useRef<unknown>(null);
  const dragging = useRef(false);
  const dragStartX = useRef(0);
  const dragStartWidth = useRef(320);

  const year = searchParams.get("year") ?? "";
  const month = searchParams.get("month") ?? "";

  useEffect(() => setMounted(true), []);

  const handleNodeClick = useCallback((data: NodeData) => {
    setSelected(data);
  }, []);

  const handleYearChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value;
    const next = new URLSearchParams(searchParams);
    if (val) {
      next.set("year", val);
    } else {
      next.delete("year");
      next.delete("month");
    }
    setSearchParams(next);
  };

  const handleMonthChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value;
    const next = new URLSearchParams(searchParams);
    if (val) {
      next.set("month", val);
    } else {
      next.delete("month");
    }
    setSearchParams(next);
  };

  // Sidebar drag-to-resize
  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    dragStartX.current = e.clientX;
    dragStartWidth.current = sidebarWidth;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onMove = (ev: MouseEvent) => {
      if (!dragging.current) return;
      // Dragging left = wider sidebar (mouse moves left from right panel's left edge)
      const delta = dragStartX.current - ev.clientX;
      const next = Math.min(700, Math.max(240, dragStartWidth.current + delta));
      setSidebarWidth(next);
    };

    const onUp = () => {
      dragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [sidebarWidth]);

  // Restore initial graph
  const handleClearSearch = useCallback(() => {
    setDisplayNodes(loaderData.nodes);
    setDisplayEdges(loaderData.edges);
    setHighlightIds([]);
    setSearchActive(false);
  }, [loaderData.nodes, loaderData.edges]);

  // Replace graph with search subgraph returned by the chat API
  const handleSearchResult = useCallback((
    entityIds: string[],
    eventIds: string[],
    subgraph: { nodes: GraphNode[]; edges: GraphEdge[] } | null
  ) => {
    if (!subgraph || subgraph.nodes.length === 0) return;
    setDisplayNodes(subgraph.nodes as typeof loaderData.nodes);
    setDisplayEdges(subgraph.edges as typeof loaderData.edges);
    setHighlightIds([...entityIds, ...eventIds]);
    setSearchActive(true);
  }, []);

  return (
    <AppShell>
      <div className="flex flex-col h-full">
        {/* ── Compact header bar ── */}
        <div className="flex items-center justify-between px-4 py-2 border-b border-[var(--color-border)] shrink-0">
          <div className="flex items-center gap-4">
            <div>
              <h1 className="text-base font-semibold leading-tight">Knowledge Graph</h1>
              <p className="text-[11px] text-white/35">
                {searchActive
                  ? `${displayNodes.length} nodes &#xb7; ${displayEdges.length} edges (search result)`
                  : `${loaderData.entityCount} entities &#xb7; ${loaderData.eventCount} events &#xb7; ${loaderData.edgeCount} edges`}
              </p>
            </div>

            {/* Time filters — inline */}
            <div className="flex items-center gap-1.5">
              <select
                value={year}
                onChange={handleYearChange}
                className="bg-[var(--color-surface-1)] border border-[var(--color-border)] rounded px-1.5 py-1 text-xs text-white/70"
              >
                <option value="">All Years</option>
                {[2024, 2025, 2026, 2027].map((y) => (
                  <option key={y} value={String(y)}>{y}</option>
                ))}
              </select>
              <select
                value={month}
                onChange={handleMonthChange}
                disabled={!year}
                className="bg-[var(--color-surface-1)] border border-[var(--color-border)] rounded px-1.5 py-1 text-xs text-white/70 disabled:opacity-30"
              >
                <option value="">All Months</option>
                {MONTHS.map((label, i) => (
                  <option key={i} value={String(i + 1)}>{label}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Sidebar toggle */}
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="text-white/40 hover:text-white/70 text-xs px-2 py-1 rounded border border-[var(--color-border)] cursor-pointer"
            title={sidebarOpen ? "Hide panel" : "Show panel"}
          >
            {sidebarOpen ? "Panel &#x25C0;" : "&#x25B6; Panel"}
          </button>
        </div>

        {/* ── Main area: graph + sidebar ── */}
        <div className="flex flex-1 min-h-0">
          {/* Graph canvas — takes remaining space */}
          <div className="flex-1 min-w-0 relative">
            {loaderData.nodes.length === 0 ? (
              <div className="absolute inset-0 flex items-center justify-center text-white/30">
                <div className="text-center">
                  <p className="text-4xl mb-3">&#x2B21;</p>
                  <p>No entities yet. Scrape some articles first.</p>
                </div>
              </div>
            ) : !mounted ? (
              <div className="absolute inset-0 flex items-center justify-center text-white/30">
                Loading graph...
              </div>
            ) : (
              <>
                <GraphCanvas
                  nodes={displayNodes}
                  edges={displayEdges}
                  onNodeClick={handleNodeClick}
                  cyInstanceRef={cyRef}
                  highlightIds={highlightIds}
                />
                <Legend />
                {searchActive && (
                  <button
                    onClick={handleClearSearch}
                    className="absolute top-3 left-3 bg-[var(--color-surface-1)]/90 backdrop-blur border border-[#facc15]/50 text-[#facc15] text-[11px] font-medium px-3 py-1.5 rounded-lg cursor-pointer hover:bg-[#facc15]/10 transition-colors z-10"
                  >
                    &#x2715; Back to full graph
                  </button>
                )}
              </>
            )}
          </div>

          {/* ── Right sidebar: chat + node detail ── */}
          {sidebarOpen && (
            <div
              className="shrink-0 flex flex-row border-l border-[var(--color-border)]"
              style={{ width: sidebarWidth }}
            >
              {/* Drag handle — sits on the very left edge of the sidebar */}
              <div
                onMouseDown={handleDragStart}
                className="w-1 shrink-0 cursor-col-resize hover:bg-[var(--color-accent)]/50 active:bg-[var(--color-accent)] transition-colors"
                title="Drag to resize"
              />

              {/* Sidebar content */}
              <div className="flex-1 min-w-0 flex flex-col bg-[var(--color-surface)]/50">
                {/* Node detail (shown when a node is selected) */}
                {selected && (
                  <div className="border-b border-[var(--color-border)] shrink-0">
                    <NodeDetail node={selected} onDismiss={() => setSelected(null)} />
                  </div>
                )}

                {/* Chat section — fills remaining space */}
                <div className="flex-1 min-h-0 flex flex-col">
                  <div className="px-3 py-1.5 border-b border-[var(--color-border)] shrink-0">
                    <p className="text-[10px] text-white/40 uppercase tracking-wide font-medium">Graph Chat</p>
                  </div>
                  <div className="flex-1 min-h-0">
                    <ChatPanel onSearchResult={handleSearchResult} />
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </AppShell>
  );
}
