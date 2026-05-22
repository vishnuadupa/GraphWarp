import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { driver } from '@/lib/neo4j/neo4j';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

export async function POST(req: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();
    const { question } = body;

    if (!question) {
      return NextResponse.json({ error: 'Question is required' }, { status: 400 });
    }

    // 1. Extract Entities using Gemini 1.5 Flash
    const extractModel = genAI.getGenerativeModel({ 
      model: 'gemini-1.5-flash',
      generationConfig: {
        responseMimeType: 'application/json'
      }
    });

    const extractPrompt = `
      Extract the key entities from the following question. 
      Return a JSON array of strings representing the entities. 
      Keep entity names concise and capitalized appropriately.
      Question: ${question}
    `;

    const extractResult = await extractModel.generateContent(extractPrompt);
    const extractText = extractResult.response.text();
    
    let entities: string[] = [];
    try {
      const jsonMatch = extractText.match(/\[[\s\S]*\]/);
      entities = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(extractText);
    } catch (e) {
      console.warn('Failed to parse entities:', extractText);
      entities = [];
    }

    // 2. Query Neo4j for the Subgraph
    const session = driver.session();
    let nodes: any[] = [];
    let links: any[] = [];
    let subgraphData = '';
    
    if (entities.length > 0) {
      try {
        const result = await session.executeRead(async (tx) => {
          return tx.run(
            `
            MATCH (n:Entity)-[r:RELATION]-(m:Entity)
            WHERE n.user_id = $userId AND n.name IN $entities
            AND m.user_id = $userId
            RETURN n, r, m
            LIMIT 100
            `,
            { userId: user.id, entities }
          );
        });

        const nodeMap = new Map();
        const linkMap = new Map();
        const pathStrings = new Set();

        result.records.forEach((record) => {
          const n = record.get('n');
          const r = record.get('r');
          const m = record.get('m');

          const nName = n.properties.name;
          const mName = m.properties.name;
          const rType = r.properties.type;

          if (!nodeMap.has(nName)) {
            nodeMap.set(nName, { id: nName, label: nName });
          }
          if (!nodeMap.has(mName)) {
            nodeMap.set(mName, { id: mName, label: mName });
          }

          const linkId = \`\${r.identity.toNumber()}\`;
          if (!linkMap.has(linkId)) {
            links.push({
              source: r.start.toNumber() === n.identity.toNumber() ? nName : mName,
              target: r.start.toNumber() === n.identity.toNumber() ? mName : nName,
              label: rType,
            });
            linkMap.set(linkId, true);
          }

          // Format for LLM context
          const sourceName = r.start.toNumber() === n.identity.toNumber() ? nName : mName;
          const targetName = r.start.toNumber() === n.identity.toNumber() ? mName : nName;
          pathStrings.add(\`\${sourceName} -[\${rType}]-> \${targetName}\`);
        });

        nodes = Array.from(nodeMap.values());
        subgraphData = Array.from(pathStrings).join('\\n');

      } catch (error) {
        console.error('Neo4j Query Error:', error);
      } finally {
        await session.close();
      }
    }

    // 3. Synthesize Answer using Gemini 1.5 Pro
    const synthModel = genAI.getGenerativeModel({ model: 'gemini-1.5-pro' });
    const synthPrompt = \`
      You are a helpful assistant. Answer the user's question based ONLY on the following knowledge graph context. 
      If the context doesn't contain the answer, say "I don't have enough information to answer that."

      Context (Knowledge Graph paths):
      \${subgraphData || "No relevant information found in the graph."}

      Question: \${question}
    \`;

    const synthResult = await synthModel.generateContent(synthPrompt);
    const answer = synthResult.response.text();

    return NextResponse.json({
      answer,
      graph: {
        nodes,
        links
      }
    });

  } catch (error: any) {
    console.error('Chat API Error:', error);
    return NextResponse.json(
      { error: 'Internal Server Error', details: error?.message }, 
      { status: 500 }
    );
  }
}
