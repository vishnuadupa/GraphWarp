import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { driver } from '@/lib/neo4j/neo4j';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    // Optional ?doc=filename filter — shows only nodes/edges from that file
    const { searchParams } = new URL(req.url);
    const docFilter = searchParams.get('doc');

    const session = driver.session();
    try {
      const query = docFilter
        ? `MATCH (n:Entity {user_id: $userId})-[r:RELATION]->(m:Entity {user_id: $userId})
           WHERE r.source_file = $docFilter OR r.source_file CONTAINS $docFilter
           WITH n, r, m,
                COUNT { (n)-[:RELATION]-() } AS nDegree,
                COUNT { (m)-[:RELATION]-() } AS mDegree
           RETURN n, r, m, nDegree, mDegree
           LIMIT 500`
        : `MATCH (n:Entity {user_id: $userId})-[r:RELATION]->(m:Entity {user_id: $userId})
           WITH n, r, m,
                COUNT { (n)-[:RELATION]-() } AS nDegree,
                COUNT { (m)-[:RELATION]-() } AS mDegree
           RETURN n, r, m, nDegree, mDegree
           LIMIT 500`;

      const result = await session.executeRead((tx) =>
        tx.run(query, { userId: user.id, docFilter: docFilter ?? '' })
      );

      const nodeMap = new Map<string, any>();
      const linkMap = new Map<string, boolean>();
      const links: any[] = [];

      result.records.forEach((record) => {
        const n       = record.get('n');
        const r       = record.get('r');
        const m       = record.get('m');
        const nDegree = record.get('nDegree')?.toNumber?.() ?? 1;
        const mDegree = record.get('mDegree')?.toNumber?.() ?? 1;

        const nName = (n.properties.name ?? '').trim();
        const mName = (m.properties.name ?? '').trim();
        if (!nName || !mName) return;

        const rType   = r.properties.type;
        const rWeight = r.properties.weight?.toNumber?.() ?? 1;
        const rSource = r.properties.source_file ?? null;

        if (!nodeMap.has(nName)) {
          nodeMap.set(nName, { id: nName, name: nName, type: n.properties.type ?? 'Entity', degree: nDegree });
        } else {
          nodeMap.get(nName).degree = Math.max(nodeMap.get(nName).degree, nDegree);
        }
        if (!nodeMap.has(mName)) {
          nodeMap.set(mName, { id: mName, name: mName, type: m.properties.type ?? 'Entity', degree: mDegree });
        } else {
          nodeMap.get(mName).degree = Math.max(nodeMap.get(mName).degree, mDegree);
        }

        const linkId = r.identity.toNumber().toString();
        if (!linkMap.has(linkId)) {
          links.push({ source: nName, target: mName, label: rType, weight: rWeight, sourceFile: rSource });
          linkMap.set(linkId, true);
        }
      });

      const nodes = Array.from(nodeMap.values());
      // Warn the client when LIMIT 500 was hit so the UI can surface a notice
      const truncated = result.records.length >= 500;

      return NextResponse.json({
        graph: { nodes, links },
        truncated,
        ...(truncated && { message: `Showing 500 of your total nodes. Upload fewer files or use the file filter to focus the graph.` }),
      });
    } finally {
      await session.close();
    }
  } catch (err: any) {
    console.error('Full graph error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
