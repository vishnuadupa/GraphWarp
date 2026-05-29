export interface NodeWithPR {
  id: string;
  pagerank?: number;
  [key: string]: any;
}

export interface LinkWithSourceTarget {
  source: string | { id: string };
  target: string | { id: string };
  [key: string]: any;
}

export function computePageRank(
  nodes: NodeWithPR[],
  links: LinkWithSourceTarget[],
  iterations = 20,
  dampingFactor = 0.85
) {
  const numNodes = nodes.length;
  if (numNodes === 0) return;

  // Initialize PageRank
  const initialPR = 1 / numNodes;
  const prMap = new Map<string, number>();
  const outDegree = new Map<string, number>();
  
  nodes.forEach(n => {
    prMap.set(n.id, initialPR);
    outDegree.set(n.id, 0);
  });

  // Calculate out-degrees
  links.forEach(l => {
    const sId = typeof l.source === 'object' ? l.source.id : l.source;
    outDegree.set(sId, (outDegree.get(sId) || 0) + 1);
  });

  // Iteratively compute PageRank
  for (let iter = 0; iter < iterations; iter++) {
    const newPrMap = new Map<string, number>();
    let sinkPR = 0;

    // Sum PR of sink nodes (nodes with 0 out-degree)
    nodes.forEach(n => {
      if (outDegree.get(n.id) === 0) {
        sinkPR += prMap.get(n.id) || 0;
      }
      newPrMap.set(n.id, 0);
    });

    // Distribute PR from edges
    links.forEach(l => {
      const sId = typeof l.source === 'object' ? l.source.id : l.source;
      const tId = typeof l.target === 'object' ? l.target.id : l.target;
      const deg = outDegree.get(sId) || 1;
      
      const currentPr = newPrMap.get(tId) || 0;
      const incomingPr = (prMap.get(sId) || 0) / deg;
      newPrMap.set(tId, currentPr + incomingPr);
    });

    // Apply damping factor and sink redistribution
    const basePR = (1 - dampingFactor) / numNodes;
    const sinkRedistribution = (dampingFactor * sinkPR) / numNodes;

    nodes.forEach(n => {
      const pr = (newPrMap.get(n.id) || 0) * dampingFactor + basePR + sinkRedistribution;
      prMap.set(n.id, pr);
    });
  }

  // Normalize and assign back to nodes
  // We want to scale them so the max PR is around 1 to make math easy for sizing
  let maxPr = 0;
  nodes.forEach(n => {
    const pr = prMap.get(n.id) || 0;
    if (pr > maxPr) maxPr = pr;
  });

  nodes.forEach(n => {
    const pr = prMap.get(n.id) || 0;
    // Normalized PR relative to max, adding base 1 so log scaling still works
    n.pagerank = maxPr > 0 ? (pr / maxPr) * 10 : 1; 
  });
}
