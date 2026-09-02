/**
 * POST /api/graph/dedup — cross-document entity resolution.
 *
 * Body:
 *   {
 *     dryRun?: boolean            // true  → propose merges only, change nothing
 *     pairs?: { canonical, duplicate }[]  // apply exactly these (human-approved)
 *     tier?: 'high' | 'all'       // which proposals to auto-apply. Default 'high'
 *     thresholds?: { embeddingHigh?, nameHigh?, reviewFloor? }
 *     limit?: number              // max entities scanned. Default 5000
 *   }
 *
 * Dry run returns a structured report (every proposal carries both signal
 * scores + a reason string) so accuracy can be scored against labelled data
 * externally. Apply mode reassigns relationships onto the canonical node, sums
 * weights, unions source_files/source_chunks, and deletes the duplicate.
 *
 * Every Cypher statement is scoped to the caller's user_id.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { driver } from '@/lib/neo4j/neo4j';
import { embeddingsEnabled } from '@/lib/embeddings';
import { proposeMerges, resolveChains, type EntityRecord, type MergeProposal } from '@/lib/entity-resolution/resolve';

export const runtime = 'nodejs';

const MAX_ENTITIES = 5000;

export async function POST(req: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const dryRun: boolean = body.dryRun === true;
    const applyAllTiers: boolean = body.tier === 'all';
    const limit: number = Math.min(Number(body.limit) || MAX_ENTITIES, MAX_ENTITIES);
    const approved: Array<{ canonical: string; duplicate: string }> | null =
      Array.isArray(body.pairs) && body.pairs.length > 0
        ? body.pairs
            .filter((p: any) => typeof p?.canonical === 'string' && typeof p?.duplicate === 'string')
            .map((p: any) => ({ canonical: p.canonical, duplicate: p.duplicate }))
        : null;

    const session = driver.session();
    let merged = 0;
    let deleted = 0;
    let proposals: MergeProposal[] = [];
    let entityCount = 0;
    let withEmbeddings = 0;

    try {
      // 1. Load the user's entity set. Embeddings are only pulled when the
      //    feature is configured — otherwise it is pure payload for nothing.
      const entityRes = await session.executeRead((tx: any) =>
        tx.run(
          `MATCH (n:Entity {user_id: $uid})
           WITH n, COUNT { (n)-[:RELATION]-() } AS degree
           RETURN n.name AS name,
                  coalesce(n.type, 'Entity') AS type,
                  degree,
                  ${embeddingsEnabled ? 'n.embedding AS embedding' : 'null AS embedding'}
           ORDER BY degree DESC, n.name ASC
           LIMIT $limit`,
          { uid: user.id, limit },
        ),
      );

      const entities: EntityRecord[] = entityRes.records.map((r: any) => {
        const raw = r.get('embedding');
        // A node may simply not have the property, or have it from a run with a
        // different dimension — either way treat it as "no embedding signal".
        const embedding = Array.isArray(raw) && raw.length > 0 ? (raw as number[]) : null;
        if (embedding) withEmbeddings++;
        return {
          name: r.get('name') as string,
          type: (r.get('type') as string) ?? 'Entity',
          degree: r.get('degree')?.toNumber?.() ?? Number(r.get('degree')) ?? 0,
          embedding,
        };
      });
      entityCount = entities.length;

      proposals = proposeMerges(entities, {
        embeddingHigh: Number(body.thresholds?.embeddingHigh) || undefined,
        nameHigh: Number(body.thresholds?.nameHigh) || undefined,
        reviewFloor: Number(body.thresholds?.reviewFloor) || undefined,
      });

      const highTier = proposals.filter((p) => p.tier === 'high');
      const report = {
        embeddingsEnabled,
        entityCount,
        withEmbeddings,
        proposals,
        counts: {
          high: highTier.length,
          medium: proposals.length - highTier.length,
          total: proposals.length,
        },
        // Back-compat with the v0 response shape.
        groupsFound: new Set(highTier.map((p) => p.canonical)).size,
        groups: groupProposals(highTier).slice(0, 50),
      };

      if (dryRun) {
        return NextResponse.json({ dryRun: true, ...report, merged: 0, deleted: 0 });
      }

      // 2. Decide what to apply: explicit approved pairs win, else the tier.
      const selected = approved ?? (applyAllTiers ? proposals : highTier).map((p) => ({
        canonical: p.canonical,
        duplicate: p.duplicate,
      }));
      const toApply = resolveChains(selected);

      if (toApply.length === 0) {
        return NextResponse.json({ dryRun: false, ...report, merged: 0, deleted: 0, applied: [] });
      }

      await session.executeWrite(async (tx: any) => {
        for (const { canonical, duplicate } of toApply) {
          if (canonical === duplicate) continue;
          const params = { dupName: duplicate, canonName: canonical, uid: user.id };

          // Union node-level provenance onto the canonical before it goes away,
          // and adopt the duplicate's type if the canonical never got a real one.
          await tx.run(
            `MATCH (dup:Entity {name: $dupName, user_id: $uid})
             MATCH (canon:Entity {name: $canonName, user_id: $uid})
             SET canon.source_files  = coalesce(canon.source_files, [])
                                       + [f IN coalesce(dup.source_files, [])
                                          WHERE NOT f IN coalesce(canon.source_files, [])],
                 canon.source_chunks = coalesce(canon.source_chunks, [])
                                       + [c IN coalesce(dup.source_chunks, [])
                                          WHERE NOT c IN coalesce(canon.source_chunks, [])],
                 canon.type = CASE WHEN canon.type IS NULL OR canon.type = 'Entity'
                                   THEN coalesce(dup.type, canon.type) ELSE canon.type END`,
            params,
          );

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
            params,
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
            params,
          );

          // Delete duplicate (DETACH removes any residual direct dup↔canon edges)
          const res = await tx.run(
            `MATCH (dup:Entity {name: $dupName, user_id: $uid}) DETACH DELETE dup RETURN count(*) AS n`,
            params,
          );
          if ((res.records[0]?.get('n')?.toNumber?.() ?? 0) > 0) deleted++;
        }
        merged = new Set(toApply.map((p) => p.canonical)).size;
      });

      return NextResponse.json({
        dryRun: false,
        ...report,
        merged,
        deleted,
        applied: toApply,
      });
    } finally {
      await session.close();
    }
  } catch (err: any) {
    console.error('[dedup] Error:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

/** v0-compatible view: { canonical, duplicates[] }. */
function groupProposals(proposals: MergeProposal[]): Array<{ canonical: string; duplicates: string[] }> {
  const byCanon = new Map<string, string[]>();
  for (const p of proposals) {
    const arr = byCanon.get(p.canonical);
    if (arr) arr.push(p.duplicate);
    else byCanon.set(p.canonical, [p.duplicate]);
  }
  return [...byCanon].map(([canonical, duplicates]) => ({ canonical, duplicates }));
}
