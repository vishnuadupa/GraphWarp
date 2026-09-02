import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { driver } from '@/lib/neo4j/neo4j';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

export const runtime = 'nodejs';
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

const redis = (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN)
  ? new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN })
  : null;

const ratelimit = redis
  ? new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(15, '1 h'), analytics: true })
  : null;

/**
 * POST /api/documents/summary
 * Body: { filename: string }
 * Returns an AI-generated summary of what this document contributed to the graph.
 */
export async function POST(req: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    if (ratelimit) {
      const { success } = await ratelimit.limit(`doc_summary_${user.id}`);
      if (!success) {
        return NextResponse.json({ error: 'Rate limit exceeded (15 summaries/hour). Please try again later.' }, { status: 429 });
      }
    }

    const { filename } = await req.json();
    if (!filename) return NextResponse.json({ error: 'filename required' }, { status: 400 });

    // Gather graph facts contributed by this document
    const session = driver.session();
    let pathStrings: string[] = [];
    let entityCount = 0;
    let topEntities: string[] = [];

    try {
      // Doc filter handles both storage formats: legacy r.source_file (string)
      // and current r.source_files (array) — see graph/full/route.ts for the
      // same pattern.
      const docFilter =
        `(r.source_file = $filename OR r.source_file CONTAINS $filename)
         OR any(f IN coalesce(r.source_files, []) WHERE f = $filename OR f CONTAINS $filename)`;

      const result = await session.executeRead((tx: any) =>
        tx.run(
          `MATCH (s:Entity {user_id: $uid})-[r:RELATION {user_id: $uid}]->(t:Entity {user_id: $uid})
           WHERE ${docFilter}
           RETURN s.name AS src, r.type AS rel, t.name AS tgt, s.type AS srcType, t.type AS tgtType
           LIMIT 80`,
          { uid: user.id, filename }
        )
      );

      const entitySet = new Set<string>();
      result.records.forEach((rec: any) => {
        const src = rec.get('src'); const rel = rec.get('rel'); const tgt = rec.get('tgt');
        entitySet.add(src); entitySet.add(tgt);
        pathStrings.push(`${src} --[${rel}]--> ${tgt}`);
      });

      entityCount = entitySet.size;

      // Top entities by degree within this doc
      const topRes = await session.executeRead((tx: any) =>
        tx.run(
          `MATCH (n:Entity {user_id: $uid})-[r:RELATION {user_id: $uid}]-()
           WHERE ${docFilter}
           RETURN n.name AS name, count(r) AS cnt ORDER BY cnt DESC LIMIT 5`,
          { uid: user.id, filename }
        )
      );
      topEntities = topRes.records.map((r: any) => r.get('name'));
    } finally {
      await session.close();
    }

    if (pathStrings.length === 0) {
      return NextResponse.json({
        summary: 'No graph data found for this document.',
        entityCount: 0,
        topEntities: [],
      });
    }

    // Generate summary with Gemini
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-lite' });
    const prompt = `
      You are a knowledge base analyst. The following facts were extracted from a document called "${filename}".
      Write a concise 2-3 sentence summary of what this document is about and what key knowledge it contributes.
      Focus on the main topics, key entities, and important relationships.
      Do not start with "This document" — be direct and informative.

      Extracted facts (${pathStrings.length} relationships, ${entityCount} unique entities):
      ${pathStrings.slice(0, 50).join('\n')}
      ${topEntities.length > 0 ? `\nKey entities: ${topEntities.join(', ')}` : ''}
    `;

    const result = await model.generateContent(prompt);
    const summary = result.response.text().trim();

    return NextResponse.json({ summary, entityCount, topEntities, relationCount: pathStrings.length });
  } catch (err: any) {
    console.error('Summary error:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
