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
    const nodeCount = 95;
    const connectionDist = 75;

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
        
        // Highly uneven, organic sizing distribution
        const sizeRand = Math.random();
        let radius = 2.0;
        if (sizeRand < 0.6) {
          radius = 1.0 + Math.random() * 1.5; // Tiny detail dots: 1.0px - 2.5px
        } else if (sizeRand < 0.9) {
          radius = 3.0 + Math.random() * 2.0; // Medium nodes: 3.0px - 5.0px
        } else {
          radius = 6.0 + Math.random() * 3.5; // Large anchor nodes: 6.0px - 9.5px
        }

        // Curated color distribution (50% charcoal ink to anchor theme, 50% color accents)
        let color = colors[0];
        const colorRand = Math.random();
        if (colorRand >= 0.50) {
          color = colors[Math.floor(Math.random() * (colors.length - 1)) + 1];
        }

        nodes.push({
          x,
          y,
          vx: (Math.random() - 0.5) * 0.35,
          vy: (Math.random() - 0.5) * 0.35,
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

      // 1. Update positions
      nodes.forEach((node) => {
        // Natural drift
        node.x += node.vx;
        node.y += node.vy;

        // Gentle boundary bounce
        if (node.x < 10 || node.x > w - 10) node.vx *= -1;
        if (node.y < 10 || node.y > h - 10) node.vy *= -1;

        // Cursor pull interaction
        const mouse = mouseRef.current;
        if (mouse.active) {
          const dx = mouse.x - node.x;
          const dy = mouse.y - node.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          const pullDist = 220;

          if (dist < pullDist) {
            const force = (pullDist - dist) / pullDist;
            node.x += (dx / dist) * force * 1.5;
            node.y += (dy / dist) * force * 1.5;
          }
        }
      });

      // 2. Draw connections
      ctx.lineWidth = 0.8;
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const n1 = nodes[i];
          const n2 = nodes[j];
          const dx = n1.x - n2.x;
          const dy = n1.y - n2.y;
          const dist = Math.sqrt(dx * dx + dy * dy);

          if (dist < connectionDist) {
            const alpha = (1 - dist / connectionDist) * 0.16;
            ctx.strokeStyle = `rgba(0, 0, 0, ${alpha})`;
            ctx.beginPath();
            ctx.moveTo(n1.x, n1.y);
            ctx.lineTo(n2.x, n2.y);
            ctx.stroke();
          }
        }
      }

      // 3. Draw nodes
      nodes.forEach((node) => {
        const mouse = mouseRef.current;
        const dx = mouse.x - node.x;
        const dy = mouse.y - node.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const isClose = dist < 70;

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
      });

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
