import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import OpenAI from 'openai';
import { driver } from '@/lib/neo4j/neo4j';

// Lazy client — instantiated per-request so missing env vars don't crash the build
function getOpenRouter() {
  return new OpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: process.env.OPENROUTER_API_KEY || 'placeholder',
  });
}

async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 4, baseDelayMs = 2000): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const msg: string = err?.message ?? '';
      const retryable =
        msg.includes('429') ||
        msg.includes('quota') ||
        msg.includes('limit') ||
        msg.includes('503') ||
        msg.includes('Service Unavailable') ||
        msg.includes('overloaded') ||
        msg.includes('high demand');

      if (!retryable || attempt === maxAttempts) throw err;

      // Back off slightly longer for 429s to allow rate limits to reset
      const delay = (msg.includes('429') || msg.includes('quota'))
        ? baseDelayMs * 2 * Math.pow(1.5, attempt - 1)
        : baseDelayMs * Math.pow(2, attempt - 1);

      console.warn(`[chat] Temporary API error. Retrying in ${Math.round(delay)}ms (attempt ${attempt}/${maxAttempts})...`);
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
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json();
    const question: string      = body.message ?? body.question;
    const selectedDocs: string[] = body.selectedDocs || [];
    // Multi-turn: last N messages from this session
    const messageHistory: { role: string; content: string }[] = body.messageHistory || [];

    if (!question) return NextResponse.json({ error: 'Message is required' }, { status: 400 });

    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        const send = (payload: object) =>
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));

        try {
          // ── Phase 1: entity extraction ────────────────────────────────────
          send({ type: 'phase', data: 'searching' });

          const extractResult = await withRetry(() =>
            getOpenRouter().chat.completions.create({
              model: 'deepseek/deepseek-v4-flash',
              messages: [{
                role: 'user',
                content: `Extract the key entities from this question as a JSON array of strings. Keep entity names concise and capitalized. Output ONLY the JSON array, no other text. Question: ${question}`,
              }],
            })
          );
          let entities: string[] = [];
          try {
            const txt = extractResult.choices[0]?.message?.content || '[]';
            const m = txt.match(/\[[\s\S]*\]/);
            entities = m ? JSON.parse(m[0]) : JSON.parse(txt);
          } catch { /* fall back */ }
          if (!Array.isArray(entities) || entities.length === 0) entities = [question];
          console.log('[chat] extracted entities:', entities);

          // Embeddings skipped — no separate embedding provider key.
          // Chat uses exact match (Step A) + substring fallback (Step B), both work without embeddings.
          const validEmbeddings: number[][] = [];

          // ── Phase 2: graph traversal ──────────────────────────────────────
          send({ type: 'phase', data: 'traversing' });

          let subgraphData = '';
          const session = driver.session();
          let nodes: any[] = [];
          let links: any[] = [];

          try {
            subgraphData = await session.executeRead(async (tx) => {
              const nodeMap = new Map<string, any>();
              const linkMap = new Map<string, boolean>();
              const pathStrings = new Set<string>();

              // Normalize selectedDocs to check filenames resiliently
              const docFilter = selectedDocs.length > 0
                ? 'AND (r1.source_file IN $selectedDocs OR any(doc IN $selectedDocs WHERE r1.source_file CONTAINS doc))'
                : '';

              const lowerEntities = entities.map((e) => e.toLowerCase());

              const processRecords = (records: any[]) => {
                records.forEach((record) => {
                  const sNode = record.get('startNode');
                  const r1 = record.get('r1');
                  const mNode = record.get('m');
                  if (!sNode || !r1 || !mNode) return;

                  const sDeg = record.get('sDeg')?.toNumber?.() ?? 1;
                  const mDeg = record.get('mDeg')?.toNumber?.() ?? 1;
                  const sName = sNode.properties.name;
                  const mName = mNode.properties.name;
                  const r1Type = r1.properties.type;
                  const r1Src = r1.properties.source_file;
                  const r1SrcValid = r1Src && r1Src !== 'Unknown' && r1Src !== 'Unknown Source';
                  const r1Prefix = r1SrcValid ? `[Source: ${r1Src}] ` : '';
                  const r1W = r1.properties.weight?.toNumber?.() ?? 1;

                  if (!nodeMap.has(sName)) nodeMap.set(sName, { id: sName, name: sName, type: sNode.properties.type ?? 'Entity', degree: sDeg });
                  if (!nodeMap.has(mName)) nodeMap.set(mName, { id: mName, name: mName, type: mNode.properties.type ?? 'Entity', degree: mDeg });

                  const lid1 = r1.identity.toNumber().toString();
                  const fwd = r1.start.toNumber() === sNode.identity.toNumber();
                  if (!linkMap.has(lid1)) {
                    links.push({ source: fwd ? sName : mName, target: fwd ? mName : sName, label: r1Type, weight: r1W });
                    linkMap.set(lid1, true);
                  }
                  // Use actual relationship direction in path string
                  pathStrings.add(`${r1Prefix}${fwd ? sName : mName} --[${r1Type}]--> ${fwd ? mName : sName}`);

                  const r2 = record.get('r2');
                  if (r2) {
                    const kNode = record.get('k');
                    // Skip k if it loops back to the start node (prevents circular path strings)
                    if (kNode && kNode.identity.toNumber() !== sNode.identity.toNumber()) {
                      const r2Type = r2.properties.type;
                      const r2Src = r2.properties.source_file;
                      const r2SrcValid = r2Src && r2Src !== 'Unknown' && r2Src !== 'Unknown Source';
                      const r2Prefix = r2SrcValid ? `[Source: ${r2Src}] ` : '';
                      const r2W = r2.properties.weight?.toNumber?.() ?? 1;
                      const kName = kNode.properties.name;
                      if (!nodeMap.has(kName)) nodeMap.set(kName, { id: kName, name: kName, type: kNode.properties.type ?? 'Entity', degree: 1 });
                      const lid2 = r2.identity.toNumber().toString();
                      const fwd2 = r2.start.toNumber() === mNode.identity.toNumber();
                      if (!linkMap.has(lid2)) {
                        links.push({ source: fwd2 ? mName : kName, target: fwd2 ? kName : mName, label: r2Type, weight: r2W });
                        linkMap.set(lid2, true);
                      }
                      // Use actual relationship direction in path string
                      pathStrings.add(`${r2Prefix}${fwd2 ? mName : kName} --[${r2Type}]--> ${fwd2 ? kName : mName}`);
                    }
                  }
                });
              };

              // Step A: Find start nodes using case-insensitive exact text search (highly reliable fallback/addition)
              if (lowerEntities.length > 0) {
                const textRes = await tx.run(
                  `MATCH (startNode:Entity)
                   WHERE startNode.user_id = $uid AND toLower(startNode.name) IN $lowerEntities
                   MATCH (startNode)-[r1:RELATION]-(m:Entity)
                   OPTIONAL MATCH (m)-[r2:RELATION]-(k:Entity)
                   WHERE m.user_id = $uid AND (k IS NULL OR (k.user_id = $uid AND k <> startNode))
                   ${docFilter}
                   WITH startNode, r1, m, r2, k,
                        COUNT { (startNode)-[:RELATION]-() } AS sDeg,
                        COUNT { (m)-[:RELATION]-() } AS mDeg
                   RETURN startNode, r1, m, r2, k, sDeg, mDeg
                   LIMIT 50`,
                  { uid: user.id, lowerEntities, selectedDocs }
                );
                processRecords(textRes.records);
              }

              // Step B: Substring containment search as fallback if exact match yielded no nodes
              if (nodeMap.size === 0 && lowerEntities.length > 0) {
                console.log('[chat] Exact match returned 0 results, trying substring fallback...');
                const substringRes = await tx.run(
                  `MATCH (startNode:Entity)
                   WHERE startNode.user_id = $uid AND any(entity IN $lowerEntities WHERE toLower(startNode.name) CONTAINS entity OR entity CONTAINS toLower(startNode.name))
                   MATCH (startNode)-[r1:RELATION]-(m:Entity)
                   OPTIONAL MATCH (m)-[r2:RELATION]-(k:Entity)
                   WHERE m.user_id = $uid AND (k IS NULL OR (k.user_id = $uid AND k <> startNode))
                   ${docFilter}
                   WITH startNode, r1, m, r2, k,
                        COUNT { (startNode)-[:RELATION]-() } AS sDeg,
                        COUNT { (m)-[:RELATION]-() } AS mDeg
                   RETURN startNode, r1, m, r2, k, sDeg, mDeg
                   LIMIT 30`,
                  { uid: user.id, lowerEntities, selectedDocs }
                );
                processRecords(substringRes.records);
              }

              // Step C: Vector similarity search (for semantic matches, wrapped safely)
              if (validEmbeddings.length > 0) {
                for (const embedding of validEmbeddings) {
                  try {
                    const vectorRes = await tx.run(
                      `CALL db.index.vector.queryNodes('entity_name_embeddings', 3, $embedding)
                       YIELD node AS startNode, score
                       WHERE startNode.user_id = $uid
                       MATCH (startNode)-[r1:RELATION]-(m:Entity)
                       OPTIONAL MATCH (m)-[r2:RELATION]-(k:Entity)
                       WHERE m.user_id = $uid AND (k IS NULL OR k.user_id = $uid)
                       ${docFilter}
                       WITH startNode, r1, m, r2, k,
                            COUNT { (startNode)-[:RELATION]-() } AS sDeg,
                            COUNT { (m)-[:RELATION]-() } AS mDeg
                       RETURN startNode, r1, m, r2, k, sDeg, mDeg
                       LIMIT 50`,
                      { uid: user.id, embedding, selectedDocs }
                    );
                    processRecords(vectorRes.records);
                  } catch (vErr) {
                    console.error('[chat] Vector similarity search failed (index may not exist yet):', vErr);
                  }
                }
              }

              nodes = Array.from(nodeMap.values());
              return Array.from(pathStrings).join('\n') + '\n';
            });
          } finally {
            await session.close();
          }

          console.log('[chat] graph results: nodes=%d links=%d subgraph_chars=%d', nodes.length, links.length, subgraphData.length);
          // Only send graph update when we actually found nodes — empty payload would clear the client graph
          if (nodes.length > 0) {
            send({ type: 'graph', data: { nodes, links }, activeNodeIds: nodes.map((n) => n.id) });
          }

          // ── Phase 3: synthesis with multi-turn context ────────────────────
          send({ type: 'phase', data: 'answering' });

          // Build conversation history context (last 6 exchanges = 12 messages max)
          const historyContext = messageHistory.length > 0
            ? `\nConversation history (most recent last):\n${
                messageHistory
                  .slice(-12)
                  .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 400)}`)
                  .join('\n')
              }\n`
            : '';

          const synthPrompt = `You are a strict, factual assistant. Answer based ONLY on the knowledge graph context below.
If the context does not contain the answer, say "I don't have enough information to answer that."
Cite sources using the [Source: filename] annotations.${historyContext}

Context (Knowledge Graph):
${subgraphData || 'No relevant information found.'}

Current question: ${question}

AT THE END output exactly 3 follow-up questions as: <suggestions>["Q1?","Q2?","Q3?"]</suggestions>`;

          const synthStream = await withRetry(() =>
            getOpenRouter().chat.completions.create({
              model: 'deepseek/deepseek-v4-flash',
              messages: [{ role: 'user', content: synthPrompt }],
              stream: true,
            })
          );
          for await (const chunk of synthStream) {
            const text = chunk.choices[0]?.delta?.content || '';
            if (text) send({ type: 'text', data: text });
          }

          send({ type: 'phase', data: null });
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));

        } catch (err: any) {
          console.error('Streaming error:', err);
          send({ type: 'error', data: err.message });
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' },
    });
  } catch (err: any) {
    console.error('Chat API error:', err);
    return NextResponse.json({ error: 'Internal Server Error', details: err?.message }, { status: 500 });
  }
}
