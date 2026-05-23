import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { driver } from '@/lib/neo4j/neo4j';

export const runtime = 'nodejs';

/**
 * POST /api/graph/search
 * Body: { query: string }
 * Returns nodes whose name contains the query string (case-insensitive).
 */
export async function POST(req: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { query } = await req.json();
    if (!query || query.trim().length < 1) {
      return NextResponse.json({ nodes: [] });
    }

    const session = driver.session();
    try {
      const result = await session.executeRead((tx) =>
        tx.run(
          `MATCH (n:Entity {user_id: $uid})
           WHERE toLower(n.name) CONTAINS toLower($query)
           WITH n, COUNT { (n)-[:RELATION]-() } AS deg
           RETURN n.name AS name, n.type AS type, deg
           ORDER BY deg DESC LIMIT 20`,
          { uid: user.id, query: query.trim() }
        )
      );

      return NextResponse.json({
        nodes: result.records.map((r) => ({
          id:     r.get('name'),
          name:   r.get('name'),
          type:   r.get('type') ?? 'Entity',
          degree: r.get('deg')?.toNumber?.() ?? 0,
        })),
      });
    } finally {
      await session.close();
    }
  } catch (err: any) {
    console.error('Graph search error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
