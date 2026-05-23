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
      const [nodeRes, linkRes, typeRes, topRes, relTypeRes, docsRes] = await Promise.all([
        session.executeRead((tx) =>
          tx.run('MATCH (n:Entity {user_id: $uid}) RETURN count(n) AS c', { uid: user.id })
        ),
        session.executeRead((tx) =>
          tx.run('MATCH ()-[r:RELATION {user_id: $uid}]->() RETURN count(r) AS c', { uid: user.id })
        ),
        session.executeRead((tx) =>
          tx.run(
            'MATCH (n:Entity {user_id: $uid}) RETURN n.type AS type, count(n) AS cnt ORDER BY cnt DESC',
            { uid: user.id }
          )
        ),
        session.executeRead((tx) =>
          tx.run(
            `MATCH (n:Entity {user_id: $uid})
             WITH n, COUNT { (n)-[:RELATION]-() } AS deg
             ORDER BY deg DESC LIMIT 8
             RETURN n.name AS name, n.type AS type, deg`,
            { uid: user.id }
          )
        ),
        session.executeRead((tx) =>
          tx.run(
            'MATCH ()-[r:RELATION {user_id: $uid}]->() RETURN r.type AS type, count(r) AS cnt ORDER BY cnt DESC LIMIT 6',
            { uid: user.id }
          )
        ),
        session.executeRead((tx) =>
          tx.run(
            `MATCH ()-[r:RELATION {user_id: $uid}]->()
             RETURN r.source_file AS doc, count(r) AS cnt ORDER BY cnt DESC`,
            { uid: user.id }
          )
        ),
      ]);

      return NextResponse.json({
        nodeCount:  nodeRes.records[0]?.get('c')?.toNumber?.() ?? 0,
        linkCount:  linkRes.records[0]?.get('c')?.toNumber?.() ?? 0,
        typeDistribution: typeRes.records.map((r) => ({
          type:  r.get('type') ?? 'Entity',
          count: r.get('cnt')?.toNumber?.() ?? 0,
        })),
        topEntities: topRes.records.map((r) => ({
          name:   r.get('name'),
          type:   r.get('type') ?? 'Entity',
          degree: r.get('deg')?.toNumber?.() ?? 0,
        })),
        topRelationTypes: relTypeRes.records.map((r) => ({
          type:  r.get('type'),
          count: r.get('cnt')?.toNumber?.() ?? 0,
        })),
        docContributions: docsRes.records.map((r) => ({
          doc:   r.get('doc') ?? 'Unknown',
          count: r.get('cnt')?.toNumber?.() ?? 0,
        })),
      });
    } finally {
      await session.close();
    }
  } catch (err: any) {
    console.error('Graph stats error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
