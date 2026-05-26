"use client";

import dynamic from "next/dynamic";
import { useRef, useEffect, useState, useCallback, useMemo } from "react";

export type ThinkingPhase = "searching" | "traversing" | "answering" | null;
export type GraphLayout = "force" | "circular" | "radial" | "hierarchical" | "grid";

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

const ForceGraph2D = dynamic(() => import("react-force-graph-2d"), { ssr: false });

export const TYPE_COLORS: Record<string, string> = {
  Person:       "#2563eb", // Royal blue
  Organization: "#d97706", // Dark amber/orange
  Location:     "#059669", // Rich emerald
  Event:        "#7c3aed", // Rich purple
  Concept:      "#db2777", // Rich pink
  Technology:   "#0891b2", // Rich cyan/teal
  Entity:       "#4b5563", // Dark slate gray
};
export const ALL_TYPES = Object.keys(TYPE_COLORS);
const DEFAULT_COLOR = "#4b5563";

function nodeRadius(degree?: number): number {
  return Math.max(5, Math.min(15, 5 + Math.log((degree ?? 1) + 1) * 2.8));
}

interface Props {
  data: GraphData;
  layout?: GraphLayout;
  thinkingPhase?: ThinkingPhase;
  matchedNodeIds?: Set<string>;     // direct entity hits (searching/traversing phase)
  activeNodeIds?: Set<string>;      // full subgraph (traversing/answering phase)
  highlightNodeIds?: Set<string>;   // search result highlights
  pathNodeIds?: Set<string>;        // path finder node highlights (gold)
  pathLinkIds?: Set<string>;        // path finder link highlights
  hiddenTypes?: Set<string>;        // entity types to hide
  onNodeClick?: (node: any) => void;
  onNodeHover?: (node: any | null) => void;
}

export function ForceGraph({
  data,
  layout = "force",
  thinkingPhase,
  matchedNodeIds,
  activeNodeIds,
  highlightNodeIds,
  pathNodeIds,
  pathLinkIds,
  hiddenTypes,
  onNodeClick,
  onNodeHover,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fgRef = useRef<any>(null);
  const [dims, setDims] = useState({ width: 0, height: 0 });

  const animTimeRef       = useRef(0);
  const phaseRef          = useRef<ThinkingPhase>(null);
  const matchedRef        = useRef<Set<string>>(new Set());
  const activeRef         = useRef<Set<string>>(new Set());
  const highlightRef      = useRef<Set<string>>(new Set());
  const pathNodeRef       = useRef<Set<string>>(new Set());
  const pathLinkRef       = useRef<Set<string>>(new Set());
  // New-node entrance animation: nodeId → performance.now() when it first appeared
  const newNodeTimestamps = useRef<Map<string, number>>(new Map());
  const prevNodeIds       = useRef<Set<string>>(new Set());

  useEffect(() => { phaseRef.current   = thinkingPhase ?? null; },     [thinkingPhase]);
  useEffect(() => { matchedRef.current = matchedNodeIds ?? new Set(); }, [matchedNodeIds]);
  useEffect(() => { activeRef.current  = activeNodeIds ?? new Set(); },  [activeNodeIds]);
  useEffect(() => { highlightRef.current = highlightNodeIds ?? new Set(); }, [highlightNodeIds]);
  useEffect(() => { pathNodeRef.current  = pathNodeIds ?? new Set(); }, [pathNodeIds]);
  useEffect(() => { pathLinkRef.current  = pathLinkIds ?? new Set(); }, [pathLinkIds]);

  // Filter graph based on hiddenTypes (hoisted above effects that depend on filteredData)
  const filteredData = useMemo(() => {
    if (!hiddenTypes || hiddenTypes.size === 0) return data;
    const visibleNodes = data.nodes.filter((n) => !hiddenTypes.has(n.type ?? "Entity"));
    const visibleIds = new Set(visibleNodes.map((n) => n.id));
    const visibleLinks = data.links.filter((l) => {
      const sId = typeof l.source === "object" ? (l.source as GraphNode).id : l.source;
      const tId = typeof l.target === "object" ? (l.target as GraphNode).id : l.target;
      return visibleIds.has(sId) && visibleIds.has(tId);
    });
    return { nodes: visibleNodes, links: visibleLinks };
  }, [data, hiddenTypes]);

  // Track which nodes are newly added — triggers entrance ripple animation
  useEffect(() => {
    const now = performance.now();
    const prev = prevNodeIds.current;
    filteredData.nodes.forEach((n) => {
      if (!prev.has(n.id) && !newNodeTimestamps.current.has(n.id)) {
        newNodeTimestamps.current.set(n.id, now);
      }
    });
    prevNodeIds.current = new Set(filteredData.nodes.map((n) => n.id));
    // Resume animation so entrance rings actually render
    if (newNodeTimestamps.current.size > 0) fgRef.current?.resumeAnimation?.();
  }, [filteredData]);

  // Resume animation when thinking starts
  useEffect(() => {
    if (thinkingPhase) fgRef.current?.resumeAnimation?.();
  }, [thinkingPhase]);

  // Also resume when search highlights appear
  useEffect(() => {
    if (highlightNodeIds && highlightNodeIds.size > 0) {
      fgRef.current?.resumeAnimation?.();
    }
  }, [highlightNodeIds]);

  // Resume when path highlights appear
  useEffect(() => {
    if (pathNodeIds && pathNodeIds.size > 0) {
      fgRef.current?.resumeAnimation?.();
    }
  }, [pathNodeIds]);

  // RAF clock
  useEffect(() => {
    let last = performance.now(); let id: number;
    const tick = (now: number) => { animTimeRef.current += (now - last) / 1000; last = now; id = requestAnimationFrame(tick); };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, []);

  // Resize observer
  useEffect(() => {
    const el = containerRef.current; if (!el) return;
    setDims({ width: el.offsetWidth, height: el.offsetHeight });
    const ro = new ResizeObserver((e) => {
      const { width, height } = e[0].contentRect; setDims({ width, height });
    });
    ro.observe(el); return () => ro.disconnect();
  }, []);

  // Apply layout: force uses D3 physics; others pre-compute fixed positions (fx/fy)
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg || dims.width === 0 || filteredData.nodes.length === 0) return;

    const nodes = filteredData.nodes as any[]; // D3 adds x, y, vx, vy, fx, fy
    const cx = dims.width / 2;
    const cy = dims.height / 2;
    const n = nodes.length;

    if (layout === "force") {
      // Release any fixed positions, let D3 physics run freely
      nodes.forEach((node) => { node.fx = undefined; node.fy = undefined; });
      fg.d3Force("charge")?.strength(-120);
      fg.d3Force("link")?.distance(75);
      fg.d3ReheatSimulation?.();
      return;
    }

    // ── Static layouts — pin every node with fx/fy ──────────────────────
    if (layout === "circular") {
      const r = Math.min(cx, cy) * 0.78;
      nodes.forEach((node, i) => {
        const angle = (2 * Math.PI * i) / n - Math.PI / 2;
        node.fx = cx + r * Math.cos(angle);
        node.fy = cy + r * Math.sin(angle);
      });

    } else if (layout === "radial") {
      // Group nodes by type; each type gets its own concentric ring
      const typeGroups = new Map<string, any[]>();
      nodes.forEach((node) => {
        const t = node.type ?? "Entity";
        if (!typeGroups.has(t)) typeGroups.set(t, []);
        typeGroups.get(t)!.push(node);
      });
      const types = Array.from(typeGroups.keys());
      const maxR = Math.min(cx, cy) * 0.88;
      const ringSpacing = types.length > 0 ? maxR / types.length : maxR;
      types.forEach((type, ti) => {
        const ring = typeGroups.get(type)!;
        const r = ringSpacing * (ti + 1);
        ring.forEach((node, i) => {
          const angle = (2 * Math.PI * i) / ring.length - Math.PI / 2;
          node.fx = cx + r * Math.cos(angle);
          node.fy = cy + r * Math.sin(angle);
        });
      });

    } else if (layout === "hierarchical") {
      // BFS from nodes that have no incoming edges
      const inDegree = new Map<string, number>(nodes.map((nd) => [nd.id, 0]));
      filteredData.links.forEach((link) => {
        const tId = typeof link.target === "object" ? (link.target as GraphNode).id : (link.target as string);
        inDegree.set(tId, (inDegree.get(tId) ?? 0) + 1);
      });

      const roots = nodes.filter((nd) => (inDegree.get(nd.id) ?? 0) === 0);
      if (roots.length === 0) roots.push(nodes[0]);

      const visited = new Set<string>();
      const levels: string[][] = [];
      let queue = roots.map((nd) => nd.id);

      while (queue.length > 0) {
        const levelIds: string[] = [];
        const next: string[] = [];
        queue.forEach((id) => {
          if (visited.has(id)) return;
          visited.add(id);
          levelIds.push(id);
          filteredData.links.forEach((link) => {
            const sId = typeof link.source === "object" ? (link.source as GraphNode).id : (link.source as string);
            const tId = typeof link.target === "object" ? (link.target as GraphNode).id : (link.target as string);
            if (sId === id && !visited.has(tId)) next.push(tId);
          });
        });
        if (levelIds.length > 0) levels.push(levelIds);
        queue = next;
      }
      // Append any disconnected nodes at the bottom
      const unvisited = nodes.filter((nd) => !visited.has(nd.id)).map((nd) => nd.id);
      if (unvisited.length > 0) levels.push(unvisited);

      const nodeMap = new Map<string, any>(nodes.map((nd) => [nd.id, nd]));
      const rowSpacing = (dims.height * 0.85) / Math.max(levels.length, 1);
      const topPad = dims.height * 0.075;
      levels.forEach((levelIds, li) => {
        const colSpacing = dims.width / (levelIds.length + 1);
        levelIds.forEach((id, ci) => {
          const node = nodeMap.get(id);
          if (node) {
            node.fx = colSpacing * (ci + 1);
            node.fy = topPad + rowSpacing * (li + 0.5);
          }
        });
      });

    } else if (layout === "grid") {
      const cols = Math.ceil(Math.sqrt(n));
      const rows = Math.ceil(n / cols);
      const cellW = (dims.width * 0.88) / cols;
      const cellH = (dims.height * 0.88) / rows;
      const startX = dims.width * 0.06 + cellW / 2;
      const startY = dims.height * 0.06 + cellH / 2;
      nodes.forEach((node, i) => {
        node.fx = startX + (i % cols) * cellW;
        node.fy = startY + Math.floor(i / cols) * cellH;
      });
    }

    // Tick the simulation once so positions are picked up immediately
    fg.d3ReheatSimulation?.();
  }, [layout, filteredData, dims]);

  const drawNode = useCallback(
    (node: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
      const n = node as GraphNode;
      const x = node.x ?? 0; const y = node.y ?? 0;
      const r = nodeRadius(n.degree);
      const color = TYPE_COLORS[n.type ?? ""] ?? DEFAULT_COLOR;
      const phase = phaseRef.current;
      const isMatched   = matchedRef.current.has(n.id);  // direct entity hit
      const isActive    = activeRef.current.has(n.id);   // in subgraph (may include matched)
      const isHighlight = highlightRef.current.size > 0 && highlightRef.current.has(n.id);
      const isOnPath    = pathNodeRef.current.has(n.id);
      const isDimmed    = (highlightRef.current.size > 0 && !highlightRef.current.has(n.id)) ||
                          (pathNodeRef.current.size > 0 && !isOnPath);
      const t = animTimeRef.current;

      // ── Phase animations ──────────────────────────────────────────────────
      if (phase === "searching") {
        // If we already know which nodes match, highlight only them with a focused beacon.
        // Otherwise fall back to the wide scanning wave across all nodes.
        if (matchedRef.current.size > 0) {
          if (isMatched) {
            // Focused pulsing halo on known entity nodes
            const pulse = 0.5 + 0.5 * Math.sin(t * 5);
            ctx.beginPath(); ctx.arc(x, y, r + 6 + pulse * 4, 0, Math.PI * 2);
            ctx.strokeStyle = `rgba(37,99,235,${0.5 + pulse * 0.4})`;
            ctx.lineWidth = 2 / globalScale; ctx.stroke();
            const grd = ctx.createRadialGradient(x, y, r, x, y, r + 14);
            grd.addColorStop(0, "rgba(37,99,235,0.2)"); grd.addColorStop(1, "rgba(37,99,235,0)");
            ctx.beginPath(); ctx.arc(x, y, r + 14, 0, Math.PI * 2); ctx.fillStyle = grd; ctx.fill();
          }
          // Non-matched nodes: no animation, they stay quiet
        } else {
          // No entity match yet — scanning wave sweeps the whole graph
          const wave = Math.sin(t * 2.5 + (x + y) / 60);
          const alpha = 0.05 + 0.08 * ((wave + 1) / 2);
          ctx.beginPath(); ctx.arc(x, y, r + 6, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(37,99,235,${alpha})`; ctx.fill();
        }
      } else if (phase === "traversing") {
        if (isMatched) {
          // Direct hits: full expanding ring animation (traversal roots)
          for (let i = 0; i < 3; i++) {
            const p = ((t * 1.4 + i * 0.33) % 1);
            ctx.beginPath(); ctx.arc(x, y, r + p * 24, 0, Math.PI * 2);
            ctx.strokeStyle = `rgba(37,99,235,${(1 - p) * 0.6})`;
            ctx.lineWidth = 1.5 / globalScale; ctx.stroke();
          }
          const grd = ctx.createRadialGradient(x, y, r * 0.4, x, y, r + 14);
          grd.addColorStop(0, "rgba(37,99,235,0.35)"); grd.addColorStop(1, "rgba(37,99,235,0)");
          ctx.beginPath(); ctx.arc(x, y, r + 14, 0, Math.PI * 2); ctx.fillStyle = grd; ctx.fill();
        } else if (isActive) {
          // Traversal neighbors: soft ambient glow — "reached" but not a root
          const pulse = 0.3 + 0.2 * Math.sin(t * 1.8 + x * 0.05);
          const grd = ctx.createRadialGradient(x, y, r, x, y, r + 10);
          grd.addColorStop(0, `rgba(37,99,235,${pulse})`); grd.addColorStop(1, "rgba(37,99,235,0)");
          ctx.beginPath(); ctx.arc(x, y, r + 10, 0, Math.PI * 2); ctx.fillStyle = grd; ctx.fill();
        }
      } else if (phase === "answering") {
        if (isMatched) {
          // Direct hits: strong green pulse
          const pulse = 0.5 + 0.5 * Math.sin(t * 3.5);
          const grd = ctx.createRadialGradient(x, y, r * 0.4, x, y, r + 16);
          grd.addColorStop(0, `rgba(5,150,105,${0.28 + pulse * 0.28})`); grd.addColorStop(1, "rgba(5,150,105,0)");
          ctx.beginPath(); ctx.arc(x, y, r + 16, 0, Math.PI * 2); ctx.fillStyle = grd; ctx.fill();
        } else if (isActive) {
          // Neighbors: softer steady green glow
          const pulse = 0.2 + 0.1 * Math.sin(t * 2 + y * 0.05);
          const grd = ctx.createRadialGradient(x, y, r, x, y, r + 10);
          grd.addColorStop(0, `rgba(5,150,105,${pulse})`); grd.addColorStop(1, "rgba(5,150,105,0)");
          ctx.beginPath(); ctx.arc(x, y, r + 10, 0, Math.PI * 2); ctx.fillStyle = grd; ctx.fill();
        }
      }

      // ── New-node entrance ripple (fires once when a node first appears) ──
      const newTs = newNodeTimestamps.current.get(n.id);
      if (newTs !== undefined) {
        const elapsed = performance.now() - newTs;
        const ENTRANCE_MS = 700;
        if (elapsed < ENTRANCE_MS) {
          const p = elapsed / ENTRANCE_MS;          // 0 → 1
          const ringR = r + p * 22;
          const alpha = (1 - p) * 0.65;
          ctx.beginPath(); ctx.arc(x, y, ringR, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(37,99,235,${alpha})`;
          ctx.lineWidth = 2 / globalScale; ctx.stroke();
          fgRef.current?.resumeAnimation?.();       // keep RAF alive until done
        } else {
          newNodeTimestamps.current.delete(n.id);   // cleanup when done
        }
      }

      // Search highlight halo (dark amber)
      if (isHighlight) {
        const pulse = 0.6 + 0.4 * Math.sin(t * 4);
        ctx.beginPath(); ctx.arc(x, y, r + 6, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(217,119,6,${pulse})`; ctx.lineWidth = 2.5 / globalScale; ctx.stroke();
      }

      // Path finder halo (teal/cyan)
      if (isOnPath) {
        const pulse = 0.5 + 0.5 * Math.sin(t * 3);
        ctx.beginPath(); ctx.arc(x, y, r + 8, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(13,148,136,${0.6 + pulse * 0.4})`;
        ctx.lineWidth = 3 / globalScale; ctx.stroke();
        const grd = ctx.createRadialGradient(x, y, r, x, y, r + 16);
        grd.addColorStop(0, "rgba(13,148,136,0.3)"); grd.addColorStop(1, "rgba(13,148,136,0)");
        ctx.beginPath(); ctx.arc(x, y, r + 16, 0, Math.PI * 2); ctx.fillStyle = grd; ctx.fill();
      }

      // Node fill
      ctx.globalAlpha = isDimmed ? 0.08 : 1;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = color; ctx.fill();

      // Border (glassy translucent white borders for dark theme)
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.strokeStyle = isOnPath ? "rgba(13,148,136,0.95)" : isHighlight ? "rgba(217,119,6,0.95)" : isActive && phase ? "rgba(255,255,255,0.95)" : "rgba(255,255,255,0.3)";
      ctx.lineWidth = (isOnPath || isHighlight || (isActive && phase) ? 2 : 1) / globalScale; ctx.stroke();

      // Label (Inter geometric display typography)
      const fontSize = Math.max(9 / globalScale, 2.5);
      ctx.font = `${isOnPath ? "bold " : ""}500 ${fontSize}px var(--font-body), "Inter", sans-serif`;
      ctx.fillStyle = isOnPath ? "rgba(45,212,191,1)" : isHighlight ? "rgba(251,191,36,1)" : isActive && phase ? "rgba(255,255,255,1)" : isDimmed ? "rgba(255,255,255,0.06)" : "rgba(243,244,246,0.85)";
      ctx.textAlign = "center"; ctx.textBaseline = "top";
      ctx.fillText(n.name ?? "", x, y + r + 3 / globalScale);
      ctx.globalAlpha = 1;
    },
    []
  );

  const typesInGraph = useMemo(
    () => Array.from(new Set(data.nodes.map((n) => n.type ?? "Entity"))).sort(),
    [data.nodes]
  );

  return (
    <div ref={containerRef} style={{ position: "absolute", inset: 0 }}>

      {/* Thinking phase badge */}
      {thinkingPhase && (
        <div style={{
          position: "absolute", top: "1rem", left: "50%", transform: "translateX(-50%)",
          zIndex: 10, padding: "0.4rem 0.8rem", borderRadius: "0px",
          background: "var(--color-paper-2)", border: "2px solid var(--color-rule)",
          color: "var(--color-ink)", fontSize: 11, fontFamily: "var(--font-mono), monospace",
          fontWeight: "bold", letterSpacing: "0.12em", textTransform: "uppercase",
          boxShadow: "2px 2px 0px rgba(0,0,0,1)", whiteSpace: "nowrap", pointerEvents: "none",
        }}>
          {thinkingPhase === "searching"  && "● Resolving entities…"}
          {thinkingPhase === "traversing" && "● Traversing graph…"}
          {thinkingPhase === "answering"  && "● Synthesising answer…"}
        </div>
      )}

      {/* Type legend */}
      {data.nodes.length > 0 && (
        <div style={{
          position: "absolute", bottom: "1.5rem", left: "1.5rem", zIndex: 10,
          display: "flex", flexDirection: "column", gap: "0.35rem",
          background: "var(--color-paper)",
          padding: "0.75rem 1rem", borderRadius: "0px",
          border: "2px solid var(--color-rule)", pointerEvents: "none",
          boxShadow: "2px 2px 0px rgba(0,0,0,1)",
        }}>
          <span style={{ fontSize: 10, color: "var(--color-neutral)", fontWeight: "bold", letterSpacing: "0.14em", textTransform: "uppercase", marginBottom: "0.2rem", fontFamily: "var(--font-mono), monospace" }}>Types</span>
          {typesInGraph.map((type) => (
            <div key={type} style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <div style={{ width: 8, height: 8, borderRadius: "0px", border: "1px solid rgba(0,0,0,0.85)", background: TYPE_COLORS[type] ?? DEFAULT_COLOR, flexShrink: 0, opacity: hiddenTypes?.has(type) ? 0.25 : 1 }} />
              <span style={{ fontSize: 10, fontWeight: "bold", color: hiddenTypes?.has(type) ? "var(--color-neutral)" : "var(--color-ink)", fontFamily: "var(--font-mono), monospace" }}>{type}</span>
            </div>
          ))}
        </div>
      )}

      {/* Zoom controls */}
      {filteredData.nodes.length > 0 && dims.width > 0 && (
        <div style={{
          position: "absolute", bottom: "1.5rem", right: "1.5rem", zIndex: 10,
          display: "flex", flexDirection: "column", gap: "0.25rem",
          background: "var(--color-paper)",
          padding: "0.3rem", borderRadius: "0px", border: "2px solid var(--color-rule)",
          boxShadow: "2px 2px 0px rgba(0,0,0,1)",
        }}>
          {([
            { l: "+", a: () => { const z = fgRef.current?.zoom(); fgRef.current?.zoom(z * 1.4, 300); } },
            { l: "−", a: () => { const z = fgRef.current?.zoom(); fgRef.current?.zoom(z / 1.4, 300); } },
            { l: "⌖", a: () => fgRef.current?.zoomToFit(400) },
          ] as { l: string; a: () => void }[]).map(({ l, a }) => (
            <button key={l} onClick={a} style={{ width: 28, height: 28, color: "var(--color-ink)", background: "var(--color-paper-2)", border: "1px solid var(--color-rule)", cursor: "pointer", fontSize: l === "⌖" ? 13 : 16, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: "0px", fontFamily: "var(--font-mono), monospace", fontWeight: "bold" }}>{l}</button>
          ))}
        </div>
      )}

      {/* Empty state */}
      {filteredData.nodes.length === 0 ? (
        <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "1rem", color: "var(--color-neutral)", fontSize: 11, letterSpacing: "0.14em", textTransform: "uppercase", fontFamily: "var(--font-mono), monospace", textAlign: "center" }}>
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--color-rule)" }}>
            <circle cx="12" cy="12" r="3" /><circle cx="4" cy="6" r="2" /><circle cx="20" cy="6" r="2" /><circle cx="4" cy="18" r="2" /><circle cx="20" cy="18" r="2" />
            <line x1="6" y1="6.5" x2="9.5" y2="11" /><line x1="18" y1="6.5" x2="14.5" y2="11" />
            <line x1="6" y1="17.5" x2="9.5" y2="13" /><line x1="18" y1="17.5" x2="14.5" y2="13" />
          </svg>
          <span style={{ color: "var(--color-ink)", fontWeight: "bold" }}>Knowledge graph<br />will appear here</span>
        </div>
      ) : dims.width > 0 ? (
        <ForceGraph2D
          ref={fgRef}
          width={dims.width}
          height={dims.height}
          graphData={filteredData}
          backgroundColor="rgba(0,0,0,0)"
          nodeLabel="name"
          nodeRelSize={6}
          nodeCanvasObjectMode={() => "replace"}
          nodeCanvasObject={drawNode}
          linkColor={(link: any) => {
            const sId = typeof link.source === "object" ? link.source.id : link.source;
            const tId = typeof link.target === "object" ? link.target.id : link.target;
            const phase = phaseRef.current;
            // Path finder links take top priority
            if (pathLinkRef.current.size > 0) {
              const lid = link.__pathId ?? `${sId}-${tId}`;
              if (pathLinkRef.current.has(sId) && pathLinkRef.current.has(tId)) return "rgba(45,212,191,0.9)";
              return "rgba(255,255,255,0.015)";
            }
            if (phase && activeRef.current.has(sId) && activeRef.current.has(tId)) {
              return phase === "answering" ? "rgba(16,185,129,0.5)" : "rgba(99,102,241,0.5)";
            }
            if (highlightRef.current.size > 0 && highlightRef.current.has(sId) && highlightRef.current.has(tId)) {
              return "rgba(245,158,11,0.5)";
            }
            if (highlightRef.current.size > 0) return "rgba(255,255,255,0.015)";
            return "rgba(255,255,255,0.08)";
          }}
          linkWidth={(link: any) => {
            const sId = typeof link.source === "object" ? link.source.id : link.source;
            const tId = typeof link.target === "object" ? link.target.id : link.target;
            if (pathLinkRef.current.size > 0 && pathLinkRef.current.has(sId) && pathLinkRef.current.has(tId)) return 3;
            return Math.max(0.6, Math.min(4.5, ((link as GraphLink).weight ?? 1) * 0.95));
          }}
          linkDirectionalArrowLength={3}
          linkDirectionalArrowRelPos={1}
          linkLabel="label"
          cooldownTicks={150}
          warmupTicks={30}
          d3AlphaDecay={0.02}
          d3VelocityDecay={0.3}
          onNodeClick={onNodeClick}
          onNodeHover={onNodeHover}
        />
      ) : null}
    </div>
  );
}
