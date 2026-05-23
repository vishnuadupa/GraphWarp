import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { driver } from '@/lib/neo4j/neo4j';

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

    let nodes: any[] = [];
    let links: any[] = [];

    const session = driver.session();
    try {
      const result = await session.executeRead(async (tx) => {
        return tx.run(
          `
          MATCH (n:Entity {name: $nodeId, user_id: $userId})-[r:RELATION]-(m:Entity {user_id: $userId})
          RETURN n, r, m
          LIMIT 50
          `,
          { userId: user.id, nodeId }
        );
      });

      const nodeMap = new Map();
      const linkMap = new Map();

      result.records.forEach((record) => {
        const n = record.get('n');
        const r = record.get('r');
        const m = record.get('m');

        const nName = n.properties.name;
        const mName = m.properties.name;
        const rType = r.properties.type;

        if (!nodeMap.has(nName)) nodeMap.set(nName, { id: nName, name: nName });
        if (!nodeMap.has(mName)) nodeMap.set(mName, { id: mName, name: mName });

        const linkId = `${r.identity.toNumber()}`;
        if (!linkMap.has(linkId)) {
          links.push({
            source: r.start.toNumber() === n.identity.toNumber() ? nName : mName,
            target: r.start.toNumber() === n.identity.toNumber() ? mName : nName,
            label: rType,
          });
          linkMap.set(linkId, true);
        }
      });

      nodes = Array.from(nodeMap.values());

    } catch (error) {
      console.error('Neo4j Query Error in Expand:', error);
      return NextResponse.json({ error: 'Graph query failed' }, { status: 500 });
    } finally {
      await session.close();
    }

    return NextResponse.json({
      graph: {
        nodes,
        links
      }
    });

  } catch (error: any) {
    console.error('Graph Expand API Error:', error);
    return NextResponse.json(
      { error: 'Internal Server Error', details: error?.message }, 
      { status: 500 }
    );
  }
}
