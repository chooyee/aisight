import { useEffect, useRef } from "react";

interface CyNode {
  data: { id: string; label: string; type: string; sector?: string };
}
interface CyEdge {
  data: { id: string; source: string; target: string; label: string };
}

interface Props {
  nodes: CyNode[];
  edges: CyEdge[];
  onNodeClick?: (node: { id: string; label: string; type: string }) => void;
}

const TYPE_COLOURS: Record<string, string> = {
  company: "#3b82f6",
  regulator: "#f59e0b",
  person: "#10b981",
  instrument: "#8b5cf6",
};

export function CytoscapeGraph({ nodes, edges, onNodeClick }: Props) {
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
          {
            selector: "node",
            style: {
              label: "data(label)",
              "font-size": 11,
              color: "#e2e8f0",
              "text-wrap": "wrap",
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
              "curve-style": "bezier",
              "target-arrow-shape": "triangle",
              "line-color": "#334155",
              "target-arrow-color": "#334155",
              width: 1.5,
            },
          },
          {
            selector: "node:selected",
            style: {
              "border-width": 3,
              "border-color": "#6366f1",
            },
          },
        ],
        layout: { name: "cose", animate: false, padding: 40 },
        userZoomingEnabled: true,
        userPanningEnabled: true,
        boxSelectionEnabled: false,
      });

      if (onNodeClick) {
        cy.on("tap", "node", (evt) => {
          const node = evt.target;
          onNodeClick({ id: node.id(), label: node.data("label"), type: node.data("type") });
        });
      }

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
