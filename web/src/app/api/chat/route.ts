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
    const selectedDocs: string[] = body.selectedDocs || [];

    if (!question) {
      return NextResponse.json({ error: 'Message is required' }, { status: 400 });
    }

    // 1. Extract Entities using Gemini 3.1 Flash Lite
    const extractModel = genAI.getGenerativeModel({
      model: 'gemini-3.1-flash-lite',
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

    const result = await withRetry(() => extractModel.generateContent(extractPrompt));
    let entities: string[] = [];
    try {
      const responseText = result.response.text();
      const jsonMatch = responseText.match(/\[.*\]/);
      entities = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(responseText);
    } catch (e) {
      console.warn('Failed to parse entities, falling back to empty list.');
    }

    if (!Array.isArray(entities) || entities.length === 0) {
      // Fallback: use the raw question if extraction failed
      entities = [question];
    }

    // 2. Embed the extracted entities
    const embedModel = genAI.getGenerativeModel({ model: 'text-embedding-004' });
    const embeddedEntities = await Promise.all(
      entities.map(async (entity) => {
        try {
          const res = await embedModel.embedContent(entity);
          return res.embedding.values;
        } catch (e) {
          console.warn(`Failed to embed search term: ${entity}`);
          return null;
        }
      })
    );

    const validEmbeddings = embeddedEntities.filter(e => e !== null);

    // 3. Query Neo4j using Vector Search for Semantic Entity Resolution
    let subgraphData = '';
    const session = driver.session();
    let nodes: any[] = [];
    let links: any[] = [];
    try {
      if (validEmbeddings.length > 0) {
        subgraphData = await session.executeRead(async (tx) => {
          let allGraphText = '';
          const nodeMap = new Map();
          const linkMap = new Map();
          const pathStrings = new Set<string>();

          for (const embedding of validEmbeddings) {
            // Find top 3 closest nodes for each extracted entity and traverse 2 hops
            const result = await tx.run(
              `
              CALL db.index.vector.queryNodes('entity_name_embeddings', 50, $embedding)
              YIELD node AS startNode, score
              WHERE startNode.user_id = $userId
              WITH startNode LIMIT 3
              MATCH (startNode)-[r1:RELATION]-(m:Entity)
              OPTIONAL MATCH (m)-[r2:RELATION]-(k:Entity)
              WHERE m.user_id = $userId AND (k IS NULL OR k.user_id = $userId)
              ${selectedDocs.length > 0 ? "AND r1.source_file IN $selectedDocs" : ""}
              RETURN startNode, r1, m, r2, k
              LIMIT 50
              `,
              { userId: user.id, embedding, selectedDocs }
            );

            result.records.forEach(record => {
              const startNode = record.get('startNode').properties.name;
              const r1 = record.get('r1').properties.type;
              const r1Source = record.get('r1').properties.source_file;
              const m = record.get('m').properties.name;
              
              if (!nodeMap.has(startNode)) nodeMap.set(startNode, { id: startNode, name: startNode });
              if (!nodeMap.has(m)) nodeMap.set(m, { id: m, name: m });
              
              const linkId1 = record.get('r1').identity.toNumber().toString();
              if (!linkMap.has(linkId1)) {
                 const src = record.get('r1').start.toNumber() === record.get('startNode').identity.toNumber() ? startNode : m;
                 const tgt = record.get('r1').start.toNumber() === record.get('startNode').identity.toNumber() ? m : startNode;
                 links.push({ source: src, target: tgt, label: r1 });
                 linkMap.set(linkId1, true);
              }
              
              pathStrings.add(`[Source File: ${r1Source}] ${startNode} --[${r1}]--> ${m}`);
              
              if (record.get('r2')) {
                 const r2 = record.get('r2').properties.type;
                 const r2Source = record.get('r2').properties.source_file;
                 const k = record.get('k').properties.name;
                 
                 if (!nodeMap.has(k)) nodeMap.set(k, { id: k, name: k });
                 const linkId2 = record.get('r2').identity.toNumber().toString();
                 if (!linkMap.has(linkId2)) {
                    const src2 = record.get('r2').start.toNumber() === record.get('m').identity.toNumber() ? m : k;
                    const tgt2 = record.get('r2').start.toNumber() === record.get('m').identity.toNumber() ? k : m;
                    links.push({ source: src2, target: tgt2, label: r2 });
                    linkMap.set(linkId2, true);
                 }
                 pathStrings.add(`[Source File: ${r2Source}] ${m} --[${r2}]--> ${k}`);
              }
            });
          }
          
          nodes = Array.from(nodeMap.values());
          return Array.from(pathStrings).join('\n') + '\n';
        });
      }
    } finally {
      await session.close();
    }

    // 4. Synthesize Answer using SSE Stream
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        try {
          const graphPayload = JSON.stringify({
            type: 'graph',
            data: { nodes, links }
          });
          controller.enqueue(encoder.encode(`data: ${graphPayload}\n\n`));

          const synthModel = genAI.getGenerativeModel({ model: 'gemini-3.1-flash-lite' });
          const synthPrompt = `
            You are a strict, factual assistant. Answer the user's question based strictly and ONLY on the following knowledge graph context. 
            If the context does not explicitly contain the answer, you must say "I don't have enough information to answer that." Do NOT infer outside knowledge.
            IMPORTANT: You MUST cite your sources using the [Source File: filename] annotations provided in the context below.
            
            AT THE VERY END of your response, you MUST output exactly 3 suggested follow-up questions wrapped in a <suggestions> tag as a JSON array of strings. 
            Example: <suggestions>["Question 1?", "Question 2?", "Question 3?"]</suggestions>

            Context (Knowledge Graph paths):
            ${subgraphData || "No relevant information found in the graph."}

            Question: ${question}
          `;

          const synthResult = await synthModel.generateContentStream(synthPrompt);
          for await (const chunk of synthResult.stream) {
            const chunkText = chunk.text();
            if (chunkText) {
              const textPayload = JSON.stringify({ type: 'text', data: chunkText });
              controller.enqueue(encoder.encode(`data: ${textPayload}\n\n`));
            }
          }

          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        } catch (streamError: any) {
          console.error("Streaming error:", streamError);
          const errPayload = JSON.stringify({ type: 'error', data: streamError.message });
          controller.enqueue(encoder.encode(`data: ${errPayload}\n\n`));
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
