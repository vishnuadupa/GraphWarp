import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { driver } from '@/lib/neo4j/neo4j';

export const runtime = 'nodejs';

/**
 * POST /api/graph/path
 * Body: { from: string, to: string }
 * Returns the shortest path between two named entities for the current user.
 */
export async function POST(req: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json();
    const from: string = body.from;
    const to: string   = body.to;

    if (!from || !to) {
      return NextResponse.json({ error: '"from" and "to" are required' }, { status: 400 });
    }

    const session = driver.session();
    try {
      const result = await session.executeRead((tx: any) =>
        tx.run(
          `MATCH (a:Entity {user_id: $userId}),
                 (b:Entity {user_id: $userId})
           WHERE toLower(a.name) = toLower($from)
             AND toLower(b.name) = toLower($to)
           MATCH p = shortestPath((a)-[:RELATION*..10]-(b))
           WHERE all(n IN nodes(p) WHERE n.user_id = $userId)
           RETURN p LIMIT 1`,
          { from, to, userId: user.id }
        )
      );

      if (result.records.length === 0) {
        return NextResponse.json({ graph: { nodes: [], links: [] }, found: false });
      }

      const path = result.records[0].get('p');
      const nodeMap = new Map<string, any>();
      const links: any[] = [];

      path.segments.forEach((seg: any) => {
        const sName = seg.start.properties.name;
        const eName = seg.end.properties.name;
        const rType = seg.relationship.properties.type;
        const rWeight = seg.relationship.properties.weight?.toNumber?.() ?? 1;

        if (!nodeMap.has(sName))
          nodeMap.set(sName, { id: sName, name: sName, type: seg.start.properties.type ?? 'Entity' });
        if (!nodeMap.has(eName))
          nodeMap.set(eName, { id: eName, name: eName, type: seg.end.properties.type ?? 'Entity' });

        const isForward = seg.relationship.start.toNumber() === seg.start.identity.toNumber();
        links.push({
          source: isForward ? sName : eName,
          target: isForward ? eName : sName,
          label:  rType,
          weight: rWeight,
        });
      });

      return NextResponse.json({
        found: true,
        graph: { nodes: Array.from(nodeMap.values()), links },
        length: path.segments.length,
      });
    } finally {
      await session.close();
    }
  } catch (err: any) {
    console.error('Graph path error:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
