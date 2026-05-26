"use client";

import { useEffect, useRef } from "react";

interface Node {
  x: number;
  y: number;
  vx: number;
  vy: number;
  baseX: number;
  baseY: number;
  radius: number;
  color: string;
  isClose?: boolean;
}

export default function LandingGraph() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const mouseRef = useRef({ x: -1000, y: -1000, active: false });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let animationFrameId: number;
    let nodes: Node[] = [];
    const nodeCount = 320;
    const connectionDist = 42;

    const initNodes = (w: number, h: number) => {
      nodes = [];
      const colors = [
        "#1a1a1a", // Charcoal Ink
        "#2563eb", // Royal Blue
        "#059669", // Emerald Green
        "#d97706", // Amber Orange
        "#4f46e5", // Electric Violet
        "#e11d48", // Crimson Rose
        "#0891b2", // Cyber Teal
      ];

      for (let i = 0; i < nodeCount; i++) {
        // Distribute nodes randomly
        const x = Math.random() * w;
        const y = Math.random() * h;
        
        // Multi-tiered starry sizing: 75% tiny nodes, 20% medium categories, 5% large statements
        const sizeRand = Math.random();
        let radius = 1.5;
        if (sizeRand < 0.75) {
          radius = 0.8 + Math.random() * 1.0; // Delicate detail dots: 0.8px - 1.8px
        } else if (sizeRand < 0.95) {
          radius = 2.5 + Math.random() * 1.7; // Medium category elements: 2.5px - 4.2px
        } else {
          radius = 5.5 + Math.random() * 3.0; // Large focal nodes: 5.5px - 8.5px
        }

        // Color distribution: Charcoal ink defaults (60%) to preserve minimalist design, colorful highlights (40%)
        let color = colors[0];
        const colorRand = Math.random();
        if (colorRand >= 0.60) {
          color = colors[Math.floor(Math.random() * (colors.length - 1)) + 1];
        }

        nodes.push({
          x,
          y,
          vx: (Math.random() - 0.5) * 0.22,
          vy: (Math.random() - 0.5) * 0.22,
          baseX: x,
          baseY: y,
          radius,
          color,
        });
      }
    };

    const resize = () => {
      const rect = containerRef.current?.getBoundingClientRect();
      const w = rect?.width || window.innerWidth;
      const h = rect?.height || window.innerHeight;
      canvas.width = w * window.devicePixelRatio;
      canvas.height = h * window.devicePixelRatio;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
      initNodes(w, h);
    };

    resize();
    window.addEventListener("resize", resize);

    // Mouse events
    const handleMouseMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      mouseRef.current = {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
        active: true,
      };
    };

    const handleMouseLeave = () => {
      mouseRef.current = { x: -1000, y: -1000, active: false };
    };

    const container = containerRef.current;
    if (container) {
      container.addEventListener("mousemove", handleMouseMove);
      container.addEventListener("mouseleave", handleMouseLeave);
    }

    // Animation Loop
    const render = () => {
      const rect = canvas.getBoundingClientRect();
      const w = rect.width;
      const h = rect.height;

      ctx.clearRect(0, 0, w, h);

      const pullDist = 220;
      const pullDistSq = pullDist * pullDist;
      const connectionDistSq = connectionDist * connectionDist;
      const closeDistSq = 70 * 70;
      const mouse = mouseRef.current;
      const mouseActive = mouse.active;
      const mouseX = mouse.x;
      const mouseY = mouse.y;

      // 1. Update positions & pre-calculate mouse distances
      // We store isClose on the node so we don't recalculate it in the drawing pass
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];

        // Natural drift
        node.x += node.vx;
        node.y += node.vy;

        // Gentle boundary bounce
        if (node.x < 10 || node.x > w - 10) node.vx *= -1;
        if (node.y < 10 || node.y > h - 10) node.vy *= -1;

        // Reset state
        node.isClose = false;

        if (mouseActive) {
          const dx = mouseX - node.x;
          const dy = mouseY - node.y;
          const distSq = dx * dx + dy * dy;

          if (distSq < pullDistSq) {
            const dist = Math.sqrt(distSq);
            const force = (pullDist - dist) / pullDist;
            node.x += (dx / dist) * force * 1.5;
            node.y += (dy / dist) * force * 1.5;
          }
          if (distSq < closeDistSq) {
            node.isClose = true;
          }
        }
      }

      // 2. Draw connections
      ctx.lineWidth = 0.8;
      for (let i = 0; i < nodes.length; i++) {
        const n1 = nodes[i];
        const n1x = n1.x;
        const n1y = n1.y;

        for (let j = i + 1; j < nodes.length; j++) {
          const n2 = nodes[j];
          const dx = n1x - n2.x;
          const dy = n1y - n2.y;
          const distSq = dx * dx + dy * dy;

          if (distSq < connectionDistSq) {
            const dist = Math.sqrt(distSq);
            const alpha = (1 - dist / connectionDist) * 0.16;
            ctx.strokeStyle = `rgba(0, 0, 0, ${alpha})`;
            ctx.beginPath();
            ctx.moveTo(n1x, n1y);
            ctx.lineTo(n2.x, n2.y);
            ctx.stroke();
          }
        }
      }

      // 3. Draw nodes
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        const isClose = node.isClose;

        ctx.beginPath();
        ctx.arc(node.x, node.y, isClose ? node.radius + 2 : node.radius, 0, Math.PI * 2);
        ctx.fillStyle = node.color;
        ctx.fill();

        // Brutalist outline for close nodes
        if (isClose) {
          ctx.strokeStyle = "rgba(0, 0, 0, 0.85)";
          ctx.lineWidth = 1.2;
          ctx.stroke();
        }
      }

      animationFrameId = requestAnimationFrame(render);
    };

    render();

    return () => {
      cancelAnimationFrame(animationFrameId);
      window.removeEventListener("resize", resize);
      if (container) {
        container.removeEventListener("mousemove", handleMouseMove);
        container.removeEventListener("mouseleave", handleMouseLeave);
      }
    };
  }, []);

  return (
    <div ref={containerRef} className="absolute inset-0 w-full h-full pointer-events-auto z-0 overflow-hidden">
      <canvas ref={canvasRef} className="block" />
    </div>
  );
}
