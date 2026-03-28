import type { LoaderFunctionArgs } from "@react-router/node";
import { useLoaderData } from "react-router";
import { useState, useEffect, useRef } from "react";
import { getDb } from "~/lib/db/client";
import { entities, relationships } from "~/lib/db/schema";
import { AppShell } from "~/components/layout/AppShell";

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const sector = url.searchParams.get("sector");
  const db = getDb();

  const entityRows = await db.select().from(entities);
  const relRows = await db.select().from(relationships);
  const nodeIds = new Set(entityRows.map((e) => e.id));

  const nodes = entityRows.map((e) => ({
    data: { id: e.id, label: e.name, type: e.type, sector: e.sector },
  }));

  const edges = relRows
    .filter((r) => nodeIds.has(r.fromEntityId) && nodeIds.has(r.toEntityId))
    .map((r) => ({
      data: { id: r.id, source: r.fromEntityId, target: r.toEntityId, label: r.relationshipType },
    }));

  return { nodes, edges, entityCount: nodes.length, edgeCount: edges.length };
}

// Lazily mount CytoscapeGraph only after hydration — avoids SSR crash
// because Cytoscape accesses window/document on import.
function GraphCanvas({
  nodes,
  edges,
  onNodeClick,
}: {
  nodes: { data: { id: string; label: string; type: string; sector?: string | null } }[];
  edges: { data: { id: string; source: string; target: string; label: string } }[];
  onNodeClick: (n: { id: string; label: string; type: string }) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<unknown>(null);

  useEffect(() => {
    if (!containerRef.current || nodes.length === 0) return;
    let destroyed = false;

    const TYPE_COLOURS: Record<string, string> = {
      company: "#3b82f6",
      regulator: "#f59e0b",
      person: "#10b981",
      instrument: "#8b5cf6",
    };

    import("cytoscape").then(({ default: cytoscape }) => {
      if (destroyed || !containerRef.current) return;
      const cy = cytoscape({
        container: containerRef.current,
        elements: { nodes, edges },
        style: [
          {
            selector: "node",
            style: {
              label: "data(label)",
              "font-size": 11,
              color: "#e2e8f0",
              "text-wrap": "wrap" as const,
              "text-max-width": "80px",
              "background-color": (ele: { data: (k: string) => string }) =>
                TYPE_COLOURS[ele.data("type")] ?? "#64748b",
              width: 32,
              height: 32,
              "border-width": 1.5,
              "border-color": "#ffffff20",
            },
          },
          {
            selector: "edge",
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
          {
            selector: "node:selected",
            style: { "border-width": 3, "border-color": "#6366f1" },
          },
        ],
        layout: { name: "cose", animate: false, padding: 40 } as never,
      });
      cy.on("tap", "node", (evt) => {
        const node = evt.target;
        onNodeClick({ id: node.id(), label: node.data("label"), type: node.data("type") });
      });
      cyRef.current = cy;
    });

    return () => {
      destroyed = true;
      if (cyRef.current) {
        (cyRef.current as { destroy: () => void }).destroy();
        cyRef.current = null;
      }
    };
  }, [nodes, edges, onNodeClick]);

  return <div ref={containerRef} className="w-full h-full" />;
}

export default function GraphPage() {
  const { nodes, edges, entityCount, edgeCount } = useLoaderData<typeof loader>();
  const [selected, setSelected] = useState<{ id: string; label: string; type: string } | null>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  return (
    <AppShell>
      <div className="flex flex-col h-full">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--color-border)]">
          <div>
            <h1 className="text-xl font-semibold">Knowledge Graph</h1>
            <p className="text-sm text-white/40 mt-0.5">
              {entityCount} entities · {edgeCount} relationships
            </p>
          </div>
          {selected && (
            <div className="bg-[var(--color-surface-1)] border border-[var(--color-border)] rounded-lg px-4 py-2 text-sm">
              <span className="text-white/50 text-xs uppercase tracking-wide">{selected.type}</span>
              <p className="font-medium mt-0.5">{selected.label}</p>
            </div>
          )}
        </div>

        {/* Graph canvas */}
        <div className="flex-1 min-h-0 relative">
          {nodes.length === 0 ? (
            <div className="absolute inset-0 flex items-center justify-center text-white/30">
              <div className="text-center">
                <p className="text-4xl mb-3">⬡</p>
                <p>No entities yet. Scrape some articles first.</p>
              </div>
            </div>
          ) : !mounted ? (
            <div className="absolute inset-0 flex items-center justify-center text-white/30">
              Loading graph…
            </div>
          ) : (
            <GraphCanvas nodes={nodes} edges={edges} onNodeClick={setSelected} />
          )}
        </div>
      </div>
    </AppShell>
  );
}
