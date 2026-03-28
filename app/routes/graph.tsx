import type { LoaderFunctionArgs } from "@react-router/node";
import { useLoaderData, useFetcher } from "react-router";
import { useState } from "react";
import { getDb } from "~/lib/db/client";
import { entities, relationships } from "~/lib/db/schema";
import { AppShell } from "~/components/layout/AppShell";
import { ClientOnly } from "~/components/ui/ClientOnly";

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

export default function GraphPage() {
  const { nodes, edges, entityCount, edgeCount } = useLoaderData<typeof loader>();
  const [selected, setSelected] = useState<{ id: string; label: string; type: string } | null>(null);

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
          ) : (
            <ClientOnly
              fallback={
                <div className="absolute inset-0 flex items-center justify-center text-white/30">
                  Loading graph…
                </div>
              }
            >
              {() => {
                const { CytoscapeGraph } = require("~/components/graph/CytoscapeGraph");
                return (
                  <CytoscapeGraph
                    nodes={nodes}
                    edges={edges}
                    onNodeClick={setSelected}
                  />
                );
              }}
            </ClientOnly>
          )}
        </div>
      </div>
    </AppShell>
  );
}
