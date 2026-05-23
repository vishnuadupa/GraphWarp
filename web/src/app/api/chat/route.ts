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
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      console.warn(`Gemini 503 on attempt ${attempt}, retrying in ${delay}ms`);
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

    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        const send = (payload: object) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        };

        try {
          // Phase 1: searching
          send({ type: 'phase', data: 'searching' });

          const extractModel = genAI.getGenerativeModel({
            model: 'gemini-2.5-flash',
            generationConfig: { responseMimeType: 'application/json' }
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
            const jsonMatch = responseText.match(/\[[\s\S]*\]/);
            entities = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(responseText);
          } catch (e) {
            console.warn('Failed to parse entities, falling back.');
          }

          if (!Array.isArray(entities) || entities.length === 0) {
            entities = [question];
          }

          // Embed entities
          const embedModel = genAI.getGenerativeModel({ model: 'text-embedding-004' });
          const embeddedEntities = await Promise.all(
            entities.map(async (entity) => {
              try {
                const res = await embedModel.embedContent(entity);
                return res.embedding.values;
              } catch (e) {
                console.warn(`Failed to embed: ${entity}`);
                return null;
              }
            })
          );
          const validEmbeddings = embeddedEntities.filter((e) => e !== null);

          // Phase 2: traversing
          send({ type: 'phase', data: 'traversing' });

          let subgraphData = '';
          const session = driver.session();
          let nodes: any[] = [];
          let links: any[] = [];

          try {
            if (validEmbeddings.length > 0) {
              subgraphData = await session.executeRead(async (tx) => {
                const nodeMap = new Map<string, any>();
                const linkMap = new Map<string, boolean>();
                const pathStrings = new Set<string>();

                for (const embedding of validEmbeddings) {
                  const docFilter = selectedDocs.length > 0
                    ? 'AND r1.source_file IN $selectedDocs'
                    : '';

                  const res = await tx.run(
                    `
                    CALL db.index.vector.queryNodes('entity_name_embeddings', 3, $embedding)
                    YIELD node AS startNode, score
                    WHERE startNode.user_id = $userId
                    MATCH (startNode)-[r1:RELATION]-(m:Entity)
                    OPTIONAL MATCH (m)-[r2:RELATION]-(k:Entity)
                    WHERE m.user_id = $userId AND (k IS NULL OR k.user_id = $userId)
                    ${docFilter}
                    WITH startNode, r1, m, r2, k,
                         size((startNode)-[:RELATION]-()) AS sDeg,
                         size((m)-[:RELATION]-()) AS mDeg
                    RETURN startNode, r1, m, r2, k, sDeg, mDeg
                    LIMIT 50
                    `,
                    { userId: user.id, embedding, selectedDocs }
                  );

                  res.records.forEach((record) => {
                    const sNode  = record.get('startNode');
                    const r1     = record.get('r1');
                    const mNode  = record.get('m');
                    const sDeg   = record.get('sDeg')?.toNumber?.() ?? 1;
                    const mDeg   = record.get('mDeg')?.toNumber?.() ?? 1;

                    const sName  = sNode.properties.name;
                    const mName  = mNode.properties.name;
                    const r1Type = r1.properties.type;
                    const r1Src  = r1.properties.source_file;
                    const r1W    = r1.properties.weight?.toNumber?.() ?? 1;

                    if (!nodeMap.has(sName))
                      nodeMap.set(sName, { id: sName, name: sName, type: sNode.properties.type ?? 'Entity', degree: sDeg });
                    if (!nodeMap.has(mName))
                      nodeMap.set(mName, { id: mName, name: mName, type: mNode.properties.type ?? 'Entity', degree: mDeg });

                    const linkId1 = r1.identity.toNumber().toString();
                    if (!linkMap.has(linkId1)) {
                      const fwd = r1.start.toNumber() === sNode.identity.toNumber();
                      links.push({ source: fwd ? sName : mName, target: fwd ? mName : sName, label: r1Type, weight: r1W });
                      linkMap.set(linkId1, true);
                    }
                    pathStrings.add(`[Source File: ${r1Src}] ${sName} --[${r1Type}]--> ${mName}`);

                    const r2 = record.get('r2');
                    if (r2) {
                      const kNode  = record.get('k');
                      const r2Type = r2.properties.type;
                      const r2Src  = r2.properties.source_file;
                      const r2W    = r2.properties.weight?.toNumber?.() ?? 1;
                      const kName  = kNode.properties.name;

                      if (!nodeMap.has(kName))
                        nodeMap.set(kName, { id: kName, name: kName, type: kNode.properties.type ?? 'Entity', degree: 1 });

                      const linkId2 = r2.identity.toNumber().toString();
                      if (!linkMap.has(linkId2)) {
                        const fwd2 = r2.start.toNumber() === mNode.identity.toNumber();
                        links.push({ source: fwd2 ? mName : kName, target: fwd2 ? kName : mName, label: r2Type, weight: r2W });
                        linkMap.set(linkId2, true);
                      }
                      pathStrings.add(`[Source File: ${r2Src}] ${mName} --[${r2Type}]--> ${kName}`);
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

          // Send graph with active node ids
          const activeNodeIds = nodes.map((n) => n.id);
          send({ type: 'graph', data: { nodes, links }, activeNodeIds });

          // Phase 3: answering
          send({ type: 'phase', data: 'answering' });

          const synthModel = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
          const synthPrompt = `
            You are a strict, factual assistant. Answer the user's question based strictly and ONLY on the following knowledge graph context.
            If the context does not explicitly contain the answer, say "I don't have enough information to answer that." Do NOT infer outside knowledge.
            IMPORTANT: Cite your sources using the [Source File: filename] annotations in the context below.

            AT THE VERY END of your response, output exactly 3 suggested follow-up questions wrapped in a <suggestions> tag as a JSON array of strings.
            Example: <suggestions>["Question 1?", "Question 2?", "Question 3?"]</suggestions>

            Context (Knowledge Graph paths):
            ${subgraphData || "No relevant information found in the graph."}

            Question: ${question}
          `;

          const synthResult = await synthModel.generateContentStream(synthPrompt);
          for await (const chunk of synthResult.stream) {
            const chunkText = chunk.text();
            if (chunkText) {
              send({ type: 'text', data: chunkText });
            }
          }

          // Clear phase
          send({ type: 'phase', data: null });
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));

        } catch (streamError: any) {
          console.error('Streaming error:', streamError);
          send({ type: 'error', data: streamError.message });
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
