import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { driver } from '@/lib/neo4j/neo4j';
import { GoogleGenerativeAI } from '@google/generative-ai';

export const runtime = 'nodejs';
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

/**
 * POST /api/graph/backfill-types
 * Re-infers entity types for nodes that still have type = 'Entity' or null.
 * Runs Gemini batch classification on up to 100 nodes at a time.
 */
export async function POST() {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const session = driver.session();
    let updatedCount = 0;

    try {
      // Find nodes missing a specific type
      const result = await session.executeRead((tx: any) =>
        tx.run(
          `MATCH (n:Entity {user_id: $uid})
           WHERE n.type IS NULL OR n.type = 'Entity'
           RETURN n.name AS name LIMIT 100`,
          { uid: user.id }
        )
      );

      const names: string[] = result.records.map((r: any) => r.get('name'));
      if (names.length === 0) {
        return NextResponse.json({ updated: 0, message: 'All entities already have types.' });
      }

      // Classify in one Gemini call
      const model = genAI.getGenerativeModel({
        model: 'gemini-2.5-flash-lite',
        generationConfig: { responseMimeType: 'application/json' },
      });

      const prompt = `
        Classify each of the following entity names into exactly one of these categories:
        Person, Organization, Location, Event, Concept, Technology, Entity

        Return a JSON object mapping each name to its category.
        Names: ${JSON.stringify(names)}
      `;

      const geminiResult = await model.generateContent(prompt);
      let typeMap: Record<string, string> = {};
      try {
        const text = geminiResult.response.text();
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        typeMap = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
      } catch {
        return NextResponse.json({ error: 'Failed to parse Gemini response' }, { status: 500 });
      }

      const VALID_TYPES = new Set(['Person','Organization','Location','Event','Concept','Technology','Entity']);

      // Write types back to Neo4j
      await session.executeWrite(async (tx: any) => {
        for (const [name, rawType] of Object.entries(typeMap)) {
          const type = VALID_TYPES.has(rawType) ? rawType : 'Entity';
          if (type === 'Entity') continue; // no change
          await tx.run(
            'MATCH (n:Entity {name: $name, user_id: $uid}) SET n.type = $type',
            { name, uid: user.id, type }
          );
          updatedCount++;
        }
      });
    } finally {
      await session.close();
    }

    return NextResponse.json({ updated: updatedCount });
  } catch (err: any) {
    console.error('Backfill error:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
