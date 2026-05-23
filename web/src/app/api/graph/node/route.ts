import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { driver } from '@/lib/neo4j/neo4j';

export const runtime = 'nodejs';

/**
 * POST /api/graph/node
 * Body: { nodeId: string }
 * Returns full detail for a single node: its relationships and source documents.
 */
export async function POST(req: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { nodeId } = await req.json();
    if (!nodeId) return NextResponse.json({ error: 'nodeId required' }, { status: 400 });

    const session = driver.session();
    try {
      const [nodeRes, relRes] = await Promise.all([
        session.executeRead((tx) =>
          tx.run(
            `MATCH (n:Entity {name: $nodeId, user_id: $uid})
             WITH n, size((n)-[:RELATION]-()) AS degree
             RETURN n.name AS name, n.type AS type, degree`,
            { nodeId, uid: user.id }
          )
        ),
        session.executeRead((tx) =>
          tx.run(
            `MATCH (n:Entity {name: $nodeId, user_id: $uid})-[r:RELATION]-(m:Entity {user_id: $uid})
             RETURN
               r.type        AS relType,
               m.name        AS other,
               m.type        AS otherType,
               r.source_file AS sourceFile,
               r.weight      AS weight,
               startNode(r) = n AS isOutgoing
             ORDER BY r.weight DESC, relType`,
            { nodeId, uid: user.id }
          )
        ),
      ]);

      if (nodeRes.records.length === 0) {
        return NextResponse.json({ error: 'Node not found' }, { status: 404 });
      }

      const n = nodeRes.records[0];
      const relationships = relRes.records.map((r) => ({
        relType:    r.get('relType'),
        other:      r.get('other'),
        otherType:  r.get('otherType') ?? 'Entity',
        sourceFile: r.get('sourceFile') ?? 'Unknown',
        weight:     r.get('weight')?.toNumber?.() ?? 1,
        isOutgoing: r.get('isOutgoing'),
      }));

      const sourceDocs = [...new Set(relationships.map((r) => r.sourceFile))];

      return NextResponse.json({
        node: {
          name:   n.get('name'),
          type:   n.get('type') ?? 'Entity',
          degree: n.get('degree')?.toNumber?.() ?? 0,
        },
        relationships,
        sourceDocs,
      });
    } finally {
      await session.close();
    }
  } catch (err: any) {
    console.error('Node detail error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
