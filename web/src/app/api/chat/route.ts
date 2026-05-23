import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { driver } from '@/lib/neo4j/neo4j';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

/** Retry a Gemini call up to `maxAttempts` times on 503 / overload errors. */
async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 3,
  baseDelayMs = 1500
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const msg: string = err?.message ?? '';
      const isRetryable =
        msg.includes('503') ||
        msg.includes('Service Unavailable') ||
        msg.includes('overloaded') ||
        msg.includes('high demand');
      if (!isRetryable || attempt === maxAttempts) throw err;
      const delay = baseDelayMs * Math.pow(2, attempt - 1); // 1.5 s, 3 s
      console.warn(`Gemini 503 on attempt ${attempt}, retrying in ${delay}ms…`);
      await new Promise((r) => setTimeout(r, delay));
      lastError = err;
    }
  }
  throw lastError;
}

export async function POST(req: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();
    const question: string = body.message ?? body.question;

    if (!question) {
      return NextResponse.json({ error: 'Message is required' }, { status: 400 });
    }

    // 1. Extract Entities using Gemini 2.5 Flash
    const extractModel = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
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

    const extractResult = await withRetry(() => extractModel.generateContent(extractPrompt));
    const extractText = extractResult.response.text();
    
    let entities: string[] = [];
    try {
      entities = JSON.parse(extractText);
    } catch (e) {
      console.warn('Failed to parse entities:', extractText);
      entities = [];
    }

    // 2. Query Neo4j for the Subgraph
    let nodes: any[] = [];
    let links: any[] = [];
    let subgraphData = '';

    if (entities.length > 0) {
      const session = driver.session();
      try {
        const result = await session.executeRead(async (tx) => {
          return tx.run(
            `
            MATCH (n:Entity)-[r:RELATION]-(m:Entity)
            WHERE n.user_id = $userId AND toLower(n.name) IN [e IN $entities | toLower(e)]
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
          const sourceFile = r.properties.source_file || 'Unknown Source';

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

          const sourceName = r.start.toNumber() === n.identity.toNumber() ? nName : mName;
          const targetName = r.start.toNumber() === n.identity.toNumber() ? mName : nName;
          pathStrings.add(`[Source File: ${sourceFile}] ${sourceName} -[${rType}]-> ${targetName}`);
        });

        nodes = Array.from(nodeMap.values());
        subgraphData = Array.from(pathStrings).join('\n');

        if (nodes.length === 0) {
          const fallbackResult = await session.executeRead(async (tx) => {
            const conditions = entities
              .map((_: string, i: number) => `toLower(n.name) CONTAINS $e${i}`)
              .join(' OR ');
            const params: Record<string, string> = { userId: user.id };
            entities.forEach((e: string, i: number) => { params[`e${i}`] = e.toLowerCase(); });
            return tx.run(
              `MATCH (n:Entity)-[r:RELATION]-(m:Entity)
               WHERE n.user_id = $userId AND m.user_id = $userId
               AND (${conditions})
               RETURN n, r, m LIMIT 100`,
              params
            );
          });

          fallbackResult.records.forEach((record) => {
            const n = record.get('n');
            const r = record.get('r');
            const m = record.get('m');
            const nName = n.properties.name;
            const mName = m.properties.name;
            const rType = r.properties.type;
            const sourceFile = r.properties.source_file || 'Unknown Source';

            if (!nodeMap.has(nName)) nodeMap.set(nName, { id: nName, name: nName });
            if (!nodeMap.has(mName)) nodeMap.set(mName, { id: mName, name: mName });
            const linkId = `${r.identity.toNumber()}`;
            if (!linkMap.has(linkId)) {
              const src = r.start.toNumber() === n.identity.toNumber() ? nName : mName;
              const tgt = r.start.toNumber() === n.identity.toNumber() ? mName : nName;
              links.push({ source: src, target: tgt, label: rType });
              linkMap.set(linkId, true);
              pathStrings.add(`[Source File: ${sourceFile}] ${src} -[${rType}]-> ${tgt}`);
            }
          });

          nodes = Array.from(nodeMap.values());
          subgraphData = Array.from(pathStrings).join('\n');
        }

      } catch (error) {
        console.error('Neo4j Query Error:', error);
      } finally {
        await session.close();
      }
    }

    // 3. Synthesize Answer using SSE Stream
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        try {
          // Send graph data first
          const graphPayload = JSON.stringify({
            type: 'graph',
            data: { nodes, links }
          });
          controller.enqueue(encoder.encode(\`data: \${graphPayload}\\n\\n\`));

          const synthModel = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
          const synthPrompt = \`
            You are a helpful assistant. Answer the user's question based ONLY on the following knowledge graph context. 
            If the context doesn't contain the answer, say "I don't have enough information to answer that."
            IMPORTANT: You MUST cite your sources using the [Source File: filename] annotations provided in the context below.
            
            Context (Knowledge Graph paths):
            \${subgraphData || "No relevant information found in the graph."}

            Question: \${question}
          \`;

          const synthResult = await synthModel.generateContentStream(synthPrompt);
          for await (const chunk of synthResult.stream) {
            const chunkText = chunk.text();
            if (chunkText) {
              const textPayload = JSON.stringify({ type: 'text', data: chunkText });
              controller.enqueue(encoder.encode(\`data: \${textPayload}\\n\\n\`));
            }
          }
          
          controller.enqueue(encoder.encode('data: [DONE]\\n\\n'));
        } catch (streamError: any) {
          console.error("Streaming error:", streamError);
          const errPayload = JSON.stringify({ type: 'error', data: streamError.message });
          controller.enqueue(encoder.encode(\`data: \${errPayload}\\n\\n\`));
        } finally {
          controller.close();
        }
      }
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });

  } catch (error: any) {
    console.error('Chat API Error:', error);
    return NextResponse.json(
      { error: 'Internal Server Error', details: error?.message }, 
      { status: 500 }
    );
  }
}
