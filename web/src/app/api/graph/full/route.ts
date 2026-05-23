import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { driver } from '@/lib/neo4j/neo4j';

export const runtime = 'nodejs';

export async function GET() {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const session = driver.session();
    try {
      const result = await session.executeRead((tx) =>
        tx.run(
          `MATCH (n:Entity {user_id: $userId})-[r:RELATION]->(m:Entity {user_id: $userId})
           WITH n, r, m,
                COUNT { (n)-[:RELATION]-() } AS nDegree,
                COUNT { (m)-[:RELATION]-() } AS mDegree
           RETURN n, r, m, nDegree, mDegree
           LIMIT 500`,
          { userId: user.id }
        )
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

        const nName = n.properties.name;
        const mName = m.properties.name;
        const rType = r.properties.type;
        const rWeight = r.properties.weight?.toNumber?.() ?? 1;

        if (!nodeMap.has(nName)) {
          nodeMap.set(nName, { id: nName, name: nName, type: n.properties.type ?? 'Entity', degree: nDegree });
        } else {
          // update degree to latest
          nodeMap.get(nName).degree = Math.max(nodeMap.get(nName).degree, nDegree);
        }
        if (!nodeMap.has(mName)) {
          nodeMap.set(mName, { id: mName, name: mName, type: m.properties.type ?? 'Entity', degree: mDegree });
        } else {
          nodeMap.get(mName).degree = Math.max(nodeMap.get(mName).degree, mDegree);
        }

        const linkId = r.identity.toNumber().toString();
        if (!linkMap.has(linkId)) {
          links.push({ source: nName, target: mName, label: rType, weight: rWeight });
          linkMap.set(linkId, true);
        }
      });

      return NextResponse.json({
        graph: {
          nodes: Array.from(nodeMap.values()),
          links,
        },
      });
    } finally {
      await session.close();
    }
  } catch (err: any) {
    console.error('Full graph error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
