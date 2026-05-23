import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { driver } from '@/lib/neo4j/neo4j';
import { GoogleGenerativeAI } from '@google/generative-ai';

export const runtime = 'nodejs';
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

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

    const { filename } = await req.json();
    if (!filename) return NextResponse.json({ error: 'filename required' }, { status: 400 });

    // Gather graph facts contributed by this document
    const session = driver.session();
    let pathStrings: string[] = [];
    let entityCount = 0;
    let topEntities: string[] = [];

    try {
      const result = await session.executeRead((tx) =>
        tx.run(
          `MATCH (s:Entity {user_id: $uid})-[r:RELATION {source_file: $filename, user_id: $uid}]->(t:Entity {user_id: $uid})
           RETURN s.name AS src, r.type AS rel, t.name AS tgt, s.type AS srcType, t.type AS tgtType
           LIMIT 80`,
          { uid: user.id, filename }
        )
      );

      const entitySet = new Set<string>();
      result.records.forEach((rec) => {
        const src = rec.get('src'); const rel = rec.get('rel'); const tgt = rec.get('tgt');
        entitySet.add(src); entitySet.add(tgt);
        pathStrings.push(`${src} --[${rel}]--> ${tgt}`);
      });

      entityCount = entitySet.size;

      // Top entities by degree within this doc
      const topRes = await session.executeRead((tx) =>
        tx.run(
          `MATCH (n:Entity {user_id: $uid})-[r:RELATION {source_file: $filename, user_id: $uid}]-()
           RETURN n.name AS name, count(r) AS cnt ORDER BY cnt DESC LIMIT 5`,
          { uid: user.id, filename }
        )
      );
      topEntities = topRes.records.map((r) => r.get('name'));
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
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
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
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
