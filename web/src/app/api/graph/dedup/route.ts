/**
 * POST /api/graph/dedup
 * Body: { dryRun?: boolean }
 *
 * Finds entity nodes whose names differ only in casing
 * (e.g. "Alice" and "alice") and merges them into the canonical node
 * (the one with the most connections; alphabetically first on a tie).
 *
 * When dryRun=true, returns what would be merged without making changes.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { driver } from '@/lib/neo4j/neo4j';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const dryRun: boolean = body.dryRun === true;

    const session = driver.session();
    let merged = 0;
    let deleted = 0;
    const groups: { canonical: string; duplicates: string[] }[] = [];

    try {
      // 1. Find all entities and their degrees
      const entityRes = await session.executeRead((tx: any) =>
        tx.run(
          `MATCH (n:Entity {user_id: $uid})
           WITH n, COUNT { (n)-[:RELATION]-() } AS degree
           RETURN n.name AS name, degree
           ORDER BY degree DESC, n.name ASC`,
          { uid: user.id },
        ),
      );

      // 2. Group by lowercase name — first entry in sorted results becomes canonical
      const groupMap = new Map<string, { canonical: string; duplicates: string[]; degree: number }>();
      for (const record of entityRes.records) {
        const name: string = record.get('name');
        const degree: number = record.get('degree')?.toNumber?.() ?? 0;
        const key = name.toLowerCase();

        if (!groupMap.has(key)) {
          groupMap.set(key, { canonical: name, duplicates: [], degree });
        } else {
          // Lower degree → duplicate; if equal degree, alphabetical order wins (ORDER BY already handles that)
          const existing = groupMap.get(key)!;
          if (degree > existing.degree) {
            // This node has more connections — promote it to canonical
            existing.duplicates.push(existing.canonical);
            existing.canonical = name;
            existing.degree = degree;
          } else {
            existing.duplicates.push(name);
          }
        }
      }

      // Collect groups that actually have duplicates
      for (const g of groupMap.values()) {
        if (g.duplicates.length > 0) {
          groups.push({ canonical: g.canonical, duplicates: g.duplicates });
        }
      }

      if (dryRun || groups.length === 0) {
        return NextResponse.json({
          dryRun,
          groupsFound: groups.length,
          groups: groups.slice(0, 50), // cap for readability
          merged: 0,
          deleted: 0,
        });
      }

      // 3. For each group, transfer relationships from duplicates to canonical then delete
      await session.executeWrite(async (tx: any) => {
        for (const group of groups) {
          for (const dupName of group.duplicates) {
            // Transfer outgoing relationships from duplicate to canonical
            await tx.run(
              `MATCH (dup:Entity {name: $dupName, user_id: $uid})-[r:RELATION]->(other:Entity {user_id: $uid})
               WHERE other.name <> $canonName
               MERGE (canon:Entity {name: $canonName, user_id: $uid})-[nr:RELATION {type: r.type, user_id: r.user_id}]->(other)
               ON CREATE SET nr.weight     = r.weight,
                             nr.created_at = r.created_at,
                             nr.source_files = coalesce(r.source_files, []),
                             nr.source_file  = r.source_file
               ON MATCH  SET nr.weight     = nr.weight + r.weight,
                             nr.source_files = [f IN coalesce(r.source_files, []) WHERE NOT f IN coalesce(nr.source_files, [])]
                                               + coalesce(nr.source_files, [])`,
              { dupName, canonName: group.canonical, uid: user.id },
            );

            // Transfer incoming relationships to canonical
            await tx.run(
              `MATCH (other:Entity {user_id: $uid})-[r:RELATION]->(dup:Entity {name: $dupName, user_id: $uid})
               WHERE other.name <> $canonName
               MERGE (other)-[nr:RELATION {type: r.type, user_id: r.user_id}]->(canon:Entity {name: $canonName, user_id: $uid})
               ON CREATE SET nr.weight     = r.weight,
                             nr.created_at = r.created_at,
                             nr.source_files = coalesce(r.source_files, []),
                             nr.source_file  = r.source_file
               ON MATCH  SET nr.weight     = nr.weight + r.weight,
                             nr.source_files = [f IN coalesce(r.source_files, []) WHERE NOT f IN coalesce(nr.source_files, [])]
                                               + coalesce(nr.source_files, [])`,
              { dupName, canonName: group.canonical, uid: user.id },
            );

            // Delete duplicate (DETACH removes any residual direct dup↔canon edges)
            await tx.run(
              `MATCH (dup:Entity {name: $dupName, user_id: $uid}) DETACH DELETE dup`,
              { dupName, uid: user.id },
            );

            deleted++;
          }
          merged++;
        }
      });
    } finally {
      await session.close();
    }

    return NextResponse.json({
      dryRun: false,
      groupsFound: groups.length,
      merged,
      deleted,
      groups: groups.slice(0, 50),
    });
  } catch (err: any) {
    console.error('[dedup] Error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
