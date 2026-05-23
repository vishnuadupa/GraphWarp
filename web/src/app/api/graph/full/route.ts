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
           RETURN n, r, m LIMIT 500`,
          { userId: user.id }
        )
      );

      const nodeMap = new Map();
      const linkMap = new Map();
      const links: any[] = [];

      result.records.forEach((record) => {
        const n = record.get('n');
        const r = record.get('r');
        const m = record.get('m');

        const nName = n.properties.name;
        const mName = m.properties.name;
        const rType = r.properties.type;

        if (!nodeMap.has(nName)) nodeMap.set(nName, { id: nName, name: nName });
        if (!nodeMap.has(mName)) nodeMap.set(mName, { id: mName, name: mName });

        const linkId = r.identity.toNumber().toString();
        if (!linkMap.has(linkId)) {
          links.push({ source: nName, target: mName, label: rType });
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
