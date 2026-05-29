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
      // Run sequentially — Neo4j sessions don't support concurrent transactions
      const nodeRes = await session.executeRead((tx: any) =>
        tx.run(
          `MATCH (n:Entity {user_id: $uid})
           WHERE toLower(n.name) = toLower($nodeId)
           WITH n, COUNT { (n)-[:RELATION]-() } AS degree
           RETURN n.name AS name, n.type AS type, degree`,
          { nodeId, uid: user.id }
        )
      );
      const relRes = await session.executeRead((tx: any) =>
        tx.run(
          `MATCH (n:Entity {user_id: $uid})-[r:RELATION]-(m:Entity {user_id: $uid})
           WHERE toLower(n.name) = toLower($nodeId)
           RETURN
             r.type AS relType,
             m.name AS other,
             m.type AS otherType,
             CASE
               WHEN size(coalesce(r.source_files, [])) > 0 THEN coalesce(r.source_files, [])[0]
               ELSE coalesce(r.source_file, 'Unknown')
             END AS sourceFile,
             coalesce(r.source_files, CASE WHEN r.source_file IS NOT NULL THEN [r.source_file] ELSE [] END) AS sourceFiles,
             r.weight AS weight,
             startNode(r) = n AS isOutgoing
           ORDER BY r.weight DESC, relType`,
          { nodeId, uid: user.id }
        )
      );

      if (nodeRes.records.length === 0) {
        return NextResponse.json({ error: 'Node not found' }, { status: 404 });
      }

      const n = nodeRes.records[0];
      const relationships = relRes.records.map((r: any) => ({
        relType:    r.get('relType'),
        other:      r.get('other'),
        otherType:  r.get('otherType') ?? 'Entity',
        sourceFile: r.get('sourceFile') ?? 'Unknown',
        sourceFiles: (r.get('sourceFiles') as string[] | null) ?? [],
        weight:     r.get('weight')?.toNumber?.() ?? 1,
        isOutgoing: r.get('isOutgoing'),
      }));

      // Collect all unique source documents across all relationships (both old and new format)
      const sourceDocs = [...new Set(
        relationships.flatMap((r: any) => r.sourceFiles.length > 0 ? r.sourceFiles : [r.sourceFile])
      )].filter((f) => f && f !== 'Unknown');

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
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
