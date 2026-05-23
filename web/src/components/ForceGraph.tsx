"use client";

import dynamic from "next/dynamic";
import { useRef, useEffect, useState, useCallback } from "react";

export type ThinkingPhase = "searching" | "traversing" | "answering" | null;

export interface GraphNode {
  id: string;
  name: string;
  type?: string;
  degree?: number;
  x?: number;
  y?: number;
}

export interface GraphLink {
  source: string | GraphNode;
  target: string | GraphNode;
  label?: string;
  weight?: number;
}

export interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
}

const ForceGraph2D = dynamic(
  () => import("react-force-graph-2d"),
  { ssr: false }
);

const TYPE_COLORS: Record<string, string> = {
  Person:       "#7eb8f7",
  Organization: "#f7a07e",
  Location:     "#7ef7a0",
  Event:        "#f7e07e",
  Concept:      "#c07ef7",
  Technology:   "#f77eb8",
  Entity:       "#9090aa",
};
const DEFAULT_COLOR = "#9090aa";

function nodeRadius(degree?: number): number {
  return Math.max(4, Math.min(14, 4 + Math.log((degree ?? 1) + 1) * 2.5));
}

interface Props {
  data: GraphData;
  thinkingPhase?: ThinkingPhase;
  activeNodeIds?: Set<string>;
  onNodeClick?: (node: any) => void;
}

export function ForceGraph({ data, thinkingPhase, activeNodeIds, onNodeClick }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fgRef = useRef<any>(null);
  const [dims, setDims] = useState({ width: 0, height: 0 });

  // Refs for animation — read inside canvas callbacks without causing re-renders
  const animTimeRef = useRef(0);
  const phaseRef = useRef<ThinkingPhase>(null);
  const activeRef = useRef<Set<string>>(new Set());

  useEffect(() => { phaseRef.current = thinkingPhase ?? null; }, [thinkingPhase]);
  useEffect(() => { activeRef.current = activeNodeIds ?? new Set(); }, [activeNodeIds]);

  // Restart the render loop whenever a thinking phase starts
  useEffect(() => {
    if (thinkingPhase && fgRef.current) {
      fgRef.current.resumeAnimation?.();
    }
  }, [thinkingPhase]);

  // Global RAF loop — keeps animTimeRef ticking independently of d3
  useEffect(() => {
    let last = performance.now();
    let id: number;
    const tick = (now: number) => {
      animTimeRef.current += (now - last) / 1000;
      last = now;
      id = requestAnimationFrame(tick);
    };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, []);

  // Resize observer
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    setDims({ width: el.offsetWidth, height: el.offsetHeight });
    const ro = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      setDims({ width, height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Canvas draw function — reads refs, never closes over props
  const drawNode = useCallback(
    (node: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
      const n = node as GraphNode;
      const x = node.x ?? 0;
      const y = node.y ?? 0;
      const r = nodeRadius(n.degree);
      const color = TYPE_COLORS[n.type ?? ""] ?? DEFAULT_COLOR;
      const phase = phaseRef.current;
      const isActive = activeRef.current.has(n.id);
      const t = animTimeRef.current;

      // ---- phase-specific glow / animation layers ----
      if (phase === "searching") {
        // Travelling shimmer wave across all nodes
        const wave = Math.sin(t * 2.5 + (x + y) / 60);
        const alpha = 0.08 + 0.12 * ((wave + 1) / 2);
        ctx.beginPath();
        ctx.arc(x, y, r + 5, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(99,102,241,${alpha})`;
        ctx.fill();
      } else if (phase === "traversing" && isActive) {
        // Three expanding rings
        for (let i = 0; i < 3; i++) {
          const p = ((t * 1.4 + i * 0.33) % 1);
          const ringR = r + p * 22;
          const alpha = (1 - p) * 0.55;
          ctx.beginPath();
          ctx.arc(x, y, ringR, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(99,102,241,${alpha})`;
          ctx.lineWidth = 1.5 / globalScale;
          ctx.stroke();
        }
        // Inner glow
        const grd = ctx.createRadialGradient(x, y, r * 0.4, x, y, r + 10);
        grd.addColorStop(0, "rgba(99,102,241,0.45)");
        grd.addColorStop(1, "rgba(99,102,241,0)");
        ctx.beginPath();
        ctx.arc(x, y, r + 10, 0, Math.PI * 2);
        ctx.fillStyle = grd;
        ctx.fill();
      } else if (phase === "answering" && isActive) {
        // Steady emerald pulse
        const pulse = 0.5 + 0.5 * Math.sin(t * 3.5);
        const grd = ctx.createRadialGradient(x, y, r * 0.4, x, y, r + 12);
        grd.addColorStop(0, `rgba(52,211,153,${0.25 + pulse * 0.3})`);
        grd.addColorStop(1, "rgba(52,211,153,0)");
        ctx.beginPath();
        ctx.arc(x, y, r + 12, 0, Math.PI * 2);
        ctx.fillStyle = grd;
        ctx.fill();
      }

      // ---- base node circle ----
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      if (isActive && phase) {
        ctx.shadowColor = color;
        ctx.shadowBlur = 10;
      }
      ctx.fillStyle = color;
      ctx.fill();
      ctx.shadowBlur = 0;

      // ---- border ----
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.strokeStyle = isActive && phase
        ? "rgba(255,255,255,0.85)"
        : "rgba(255,255,255,0.18)";
      ctx.lineWidth = (isActive && phase ? 1.5 : 0.6) / globalScale;
      ctx.stroke();

      // ---- label ----
      const label = n.name ?? "";
      const fontSize = Math.max(9 / globalScale, 2);
      ctx.font = `${fontSize}px "Geist", system-ui, sans-serif`;
      ctx.fillStyle = isActive && phase
        ? "rgba(255,255,255,0.95)"
        : "rgba(200,200,225,0.65)";
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillText(label, x, y + r + 2 / globalScale);
    },
    []
  );

  // Derive unique entity types for the legend
  const typesInGraph = Array.from(
    new Set(data.nodes.map((n) => n.type ?? "Entity"))
  ).sort();

  return (
    <div ref={containerRef} style={{ position: "absolute", inset: 0 }}>

      {/* Entity type legend */}
      {data.nodes.length > 0 && (
        <div style={{
          position: "absolute", bottom: "1.5rem", left: "1rem", zIndex: 10,
          display: "flex", flexDirection: "column", gap: "0.28rem",
          background: "rgba(8,8,10,0.80)", backdropFilter: "blur(10px)",
          padding: "0.55rem 0.75rem", borderRadius: "0.6rem",
          border: "1px solid rgba(255,255,255,0.07)",
          pointerEvents: "none",
        }}>
          <span style={{ fontSize: 9, color: "rgba(255,255,255,0.3)", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: "0.15rem", fontFamily: "system-ui" }}>Entity Types</span>
          {typesInGraph.map((type) => (
            <div key={type} style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
              <div style={{
                width: 7, height: 7, borderRadius: "50%",
                background: TYPE_COLORS[type] ?? DEFAULT_COLOR,
                flexShrink: 0,
              }} />
              <span style={{ fontSize: 10, color: "rgba(255,255,255,0.50)", fontFamily: "system-ui" }}>{type}</span>
            </div>
          ))}
        </div>
      )}

      {/* Thinking phase badge */}
      {thinkingPhase && (
        <div style={{
          position: "absolute", top: "4.5rem", left: "50%", transform: "translateX(-50%)",
          zIndex: 10, padding: "0.28rem 0.75rem", borderRadius: "999px",
          background: "rgba(99,102,241,0.12)", border: "1px solid rgba(99,102,241,0.28)",
          color: "rgba(165,168,255,0.92)", fontSize: 10, fontFamily: "system-ui",
          letterSpacing: "0.10em", textTransform: "uppercase",
          backdropFilter: "blur(8px)", whiteSpace: "nowrap",
        }}>
          {thinkingPhase === "searching"   && "● Resolving entities…"}
          {thinkingPhase === "traversing"  && "● Traversing graph…"}
          {thinkingPhase === "answering"   && "● Synthesising answer…"}
        </div>
      )}

      {/* Zoom controls */}
      {data.nodes.length > 0 && dims.width > 0 && (
        <div style={{
          position: "absolute", bottom: "1.5rem", right: "1rem", zIndex: 10,
          display: "flex", flexDirection: "column", gap: "0.25rem",
          background: "rgba(8,8,10,0.80)", backdropFilter: "blur(10px)",
          padding: "0.3rem", borderRadius: "0.5rem",
          border: "1px solid rgba(255,255,255,0.07)",
        }}>
          {([
            { label: "+", action: () => { const z = fgRef.current?.zoom(); fgRef.current?.zoom(z * 1.4, 300); } },
            { label: "−", action: () => { const z = fgRef.current?.zoom(); fgRef.current?.zoom(z / 1.4, 300); } },
            { label: "⌖", action: () => fgRef.current?.zoomToFit(400) },
          ] as { label: string; action: () => void }[]).map(({ label, action }) => (
            <button
              key={label}
              onClick={action}
              style={{
                width: 28, height: 28, color: "rgba(255,255,255,0.65)",
                background: "rgba(255,255,255,0.05)", border: "none",
                cursor: "pointer", fontSize: label === "⌖" ? 13 : 16,
                display: "flex", alignItems: "center", justifyContent: "center",
                borderRadius: "0.3rem",
              }}
            >{label}</button>
          ))}
        </div>
      )}

      {/* Empty state */}
      {data.nodes.length === 0 ? (
        <div style={{
          position: "absolute", inset: 0,
          display: "flex", flexDirection: "column",
          alignItems: "center", justifyContent: "center",
          gap: "1rem", color: "rgba(255,255,255,0.18)",
          fontSize: 10, letterSpacing: "0.12em",
          textTransform: "uppercase", fontFamily: "system-ui",
          textAlign: "center",
        }}>
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" /><circle cx="4"  cy="6"  r="2" />
            <circle cx="20" cy="6"  r="2" /><circle cx="4"  cy="18" r="2" />
            <circle cx="20" cy="18" r="2" />
            <line x1="6"  y1="6.5"  x2="9.5"  y2="11" />
            <line x1="18" y1="6.5"  x2="14.5" y2="11" />
            <line x1="6"  y1="17.5" x2="9.5"  y2="13" />
            <line x1="18" y1="17.5" x2="14.5" y2="13" />
          </svg>
          <span>Knowledge graph<br />will appear here</span>
        </div>
      ) : dims.width > 0 ? (
        <ForceGraph2D
          ref={fgRef}
          width={dims.width}
          height={dims.height}
          graphData={data}
          backgroundColor="#050505"
          nodeLabel="name"
          nodeRelSize={5}
          nodeCanvasObjectMode={() => "replace"}
          nodeCanvasObject={drawNode}
          linkColor={(link: any) => {
            const srcId = typeof link.source === "object" ? link.source.id : link.source;
            const tgtId = typeof link.target === "object" ? link.target.id : link.target;
            const phase = phaseRef.current;
            if (phase && activeRef.current.has(srcId) && activeRef.current.has(tgtId)) {
              return phase === "answering"
                ? "rgba(52,211,153,0.55)"
                : "rgba(99,102,241,0.55)";
            }
            return "rgba(255,255,255,0.07)";
          }}
          linkWidth={(link: any) =>
            Math.max(0.5, Math.min(4, ((link as GraphLink).weight ?? 1) * 0.8))
          }
          linkDirectionalArrowLength={3}
          linkDirectionalArrowRelPos={1}
          linkLabel="label"
          cooldownTicks={150}
          warmupTicks={30}
          d3AlphaDecay={0.02}
          d3VelocityDecay={0.3}
          onNodeClick={onNodeClick}
        />
      ) : null}
    </div>
  );
}
