"use client";

import dynamic from "next/dynamic";
import { useRef, useEffect, useState } from "react";

export interface GraphNode {
  id: string;
  name: string;
  type?: string;
}

export interface GraphLink {
  source: string;
  target: string;
  label?: string;
}

export interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
}

const ForceGraph2D = dynamic(
  () => import("react-force-graph-2d"),
  { ssr: false }
);

interface Props {
  data: GraphData;
}

export function ForceGraph({ data }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    // Seed immediately, then track every resize
    setDims({ width: el.offsetWidth, height: el.offsetHeight });
    const ro = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      setDims({ width, height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Single wrapper: position absolute so it always fills the
  // position:relative .graph-panel regardless of flex layout state.
  return (
    <div ref={containerRef} style={{ position: "absolute", inset: 0 }}>
      {data.nodes.length === 0 ? (
        <div className="graph-empty">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <circle cx="4"  cy="6"  r="2" />
            <circle cx="20" cy="6"  r="2" />
            <circle cx="4"  cy="18" r="2" />
            <circle cx="20" cy="18" r="2" />
            <line x1="6"  y1="6.5"  x2="9.5"  y2="11" />
            <line x1="18" y1="6.5"  x2="14.5" y2="11" />
            <line x1="6"  y1="17.5" x2="9.5"  y2="13" />
            <line x1="18" y1="17.5" x2="14.5" y2="13" />
          </svg>
          <span>ASK A QUESTION<br />TO POPULATE THE GRAPH</span>
        </div>
      ) : dims.width > 0 ? (
        <ForceGraph2D
          width={dims.width}
          height={dims.height}
          graphData={data}
          backgroundColor="oklch(18% 0.009 260)"
          nodeLabel="name"
          nodeRelSize={5}
          nodeColor={() => "oklch(88% 0.007 260)"}
          nodeCanvasObjectMode={() => "after"}
          nodeCanvasObject={(node, ctx, globalScale) => {
            const label = (node as GraphNode).name ?? "";
            const fontSize = Math.max(10 / globalScale, 2);
            ctx.font = `${fontSize}px "Geist", system-ui, sans-serif`;
            ctx.fillStyle = "oklch(70% 0.006 260)";
            ctx.textAlign = "center";
            ctx.textBaseline = "top";
            ctx.fillText(label, node.x ?? 0, (node.y ?? 0) + 7);
          }}
          linkColor={() => "oklch(35% 0.008 260)"}
          linkWidth={1}
          linkDirectionalArrowLength={4}
          linkDirectionalArrowRelPos={1}
          linkLabel="label"
          cooldownTicks={120}
          d3AlphaDecay={0.02}
          d3VelocityDecay={0.3}
        />
      ) : null}
    </div>
  );
}
