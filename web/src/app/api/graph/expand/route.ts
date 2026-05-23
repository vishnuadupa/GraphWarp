import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { driver } from '@/lib/neo4j/neo4j';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();
    const nodeId: string = body.nodeId;

    if (!nodeId) {
      return NextResponse.json({ error: 'Node ID is required' }, { status: 400 });
    }

    const session = driver.session();
    try {
      const result = await session.executeRead(async (tx) =>
        tx.run(
          `MATCH (n:Entity {name: $nodeId, user_id: $userId})-[r:RELATION]-(m:Entity {user_id: $userId})
           WITH n, r, m,
                size((n)-[:RELATION]-()) AS nDegree,
                size((m)-[:RELATION]-()) AS mDegree
           RETURN n, r, m, nDegree, mDegree
           LIMIT 50`,
          { userId: user.id, nodeId }
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

        const nName   = n.properties.name;
        const mName   = m.properties.name;
        const rType   = r.properties.type;
        const rWeight = r.properties.weight?.toNumber?.() ?? 1;

        if (!nodeMap.has(nName))
          nodeMap.set(nName, { id: nName, name: nName, type: n.properties.type ?? 'Entity', degree: nDegree });
        if (!nodeMap.has(mName))
          nodeMap.set(mName, { id: mName, name: mName, type: m.properties.type ?? 'Entity', degree: mDegree });

        const linkId = r.identity.toNumber().toString();
        if (!linkMap.has(linkId)) {
          const isForward = r.start.toNumber() === n.identity.toNumber();
          links.push({
            source: isForward ? nName : mName,
            target: isForward ? mName : nName,
            label:  rType,
            weight: rWeight,
          });
          linkMap.set(linkId, true);
        }
      });

      return NextResponse.json({
        graph: { nodes: Array.from(nodeMap.values()), links },
      });

    } finally {
      await session.close();
    }
  } catch (error: any) {
    console.error('Graph Expand API Error:', error);
    return NextResponse.json(
      { error: 'Internal Server Error', details: error?.message },
      { status: 500 }
    );
  }
}
