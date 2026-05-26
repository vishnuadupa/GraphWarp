## 2025-03-09 - Math.sqrt() in Animation Loops
**Learning:** O(N^2) loops in `requestAnimationFrame` using `Math.sqrt()` (like distance calculations in Force/Landing graphs) are significant bottlenecks.
**Action:** Always pre-calculate squared distance thresholds (`dist * dist`) and compare against squared distances (`dx * dx + dy * dy`), only using `Math.sqrt()` inside the hit block when the actual distance value is needed.
