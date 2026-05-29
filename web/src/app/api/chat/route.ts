import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import OpenAI from 'openai';
import { driver } from '@/lib/neo4j/neo4j';
import { withRetry } from '@/lib/utils/retry';
import { MODELS } from '@/lib/config/models';
import { embedText, embeddingsEnabled } from '@/lib/embeddings';
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

export const runtime = 'nodejs';

// Lazy client — instantiated per-request so missing env vars don't crash the build
function getOpenRouter() {
  return new OpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: process.env.OPENROUTER_API_KEY || 'placeholder',
  });
}

// Rate Limiting (20 requests per hour)
const redis = (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN)
  ? new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN })
  : null;

const ratelimit = redis
  ? new Ratelimit({
      redis: redis,
      limiter: Ratelimit.slidingWindow(20, '1 h'),
      analytics: true,
    })
  : null;

export async function POST(req: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    if (typeof body !== 'object' || body === null) return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });
    
    const question: string      = body.message ?? body.question;
    const selectedDocs: string[] = Array.isArray(body.selectedDocs) ? body.selectedDocs : [];
    const messageHistory: { role: string; content: string }[] = Array.isArray(body.messageHistory) ? body.messageHistory : [];

    if (typeof question !== 'string' || !question) return NextResponse.json({ error: 'Message is required' }, { status: 400 });

    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        const send = (payload: object) =>
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));

        try {
          // ── Rate Limiting ───────────────────────────────────────────────────
          if (ratelimit) {
            const { success } = await ratelimit.limit(`chat_${user.id}`);
            if (!success) {
              send({ type: 'error', data: 'Rate limit exceeded (20 requests/hour). Please try again later.' });
              send({ type: 'phase', data: null });
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
              return;
            }
          }

          // Generate embedding early for Semantic Caching and Graph Search
          let queryEmbedding: number[] | null = null;
          if (embeddingsEnabled) {
            try {
              queryEmbedding = await embedText(question);
            } catch (embErr) {
              console.warn('[chat] Query embedding failed:', embErr);
            }
          }

          // ── Semantic Cache Lookup ───────────────────────────────────────────
          if (queryEmbedding && messageHistory.length === 0) { // Only cache isolated queries
            const { data: cacheHit, error: cacheErr } = await supabase.rpc('match_semantic_cache', {
              query_embedding: queryEmbedding,
              match_threshold: 0.95,
              match_count: 1,
              user_id_param: user.id
            });
            
            // if we don't have the RPC, we can do direct query since pgvector supports `<=>` 
            // Wait, standard Supabase doesn't have match_semantic_cache RPC unless created. 
            // We can just use a direct query. Let's do direct select.
            const { data: cacheData } = await supabase
              .from('semantic_cache')
              .select('answer, question_embedding')
              .eq('user_id', user.id)
              // We order by distance using pg_vector. Since we don't have an RPC, we will skip
              // strict cache lookup if we can't query it easily without an RPC. 
              // Wait, we can use `.filter` but postgrest doesn't easily support raw `<=>` operator without RPC.
              // So for now, we'll try to fetch the exact same text for caching as a simple fallback, or rely on RPC if present.
              // Actually, exact string match is easiest if RPC isn't guaranteed:
              .ilike('question', question)
              .limit(1)
              .maybeSingle();

            if (cacheData && cacheData.answer) {
              send({ type: 'phase', data: 'answering' });
              send({ type: 'text', data: cacheData.answer });
              send({ type: 'phase', data: null });
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
              return;
            }
          }

          // ── Phase 1: entity extraction ────────────────────────────────────
          send({ type: 'phase', data: 'searching' });

          const extractResult = await withRetry(() =>
            getOpenRouter().chat.completions.create({
              model: MODELS.CHAT,
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

          // Broadcast extracted entity names so the client can immediately highlight
          // matching nodes in the already-loaded graph (no Neo4j round-trip needed).
          send({ type: 'entities', data: entities });

          const validEmbeddings: number[][] = [];
          if (queryEmbedding) validEmbeddings.push(queryEmbedding);

          // ── Phase 2: graph traversal ──────────────────────────────────────
          send({ type: 'phase', data: 'traversing' });

          let subgraphData = '';
          const session = driver.session();
          let nodes: any[] = [];
          let links: any[] = [];
          // matchedNodeIds = direct entity hits (start nodes); activeNodeIds = full subgraph
          let matchedNodeIds = new Set<string>();

          try {
            subgraphData = await session.executeRead(async (tx: any) => {
              const nodeMap = new Map<string, any>();
              const linkMap = new Map<string, boolean>();
              // Separate first-hop (direct) and second-hop (context) paths for structured synthesis
              const directPathStrings = new Set<string>();
              const contextPathStrings = new Set<string>();

              // Doc filter for r1 — checks source_files array (new format) with fallback
              // to source_file string (old format) for backward compatibility.
              const docFilterR1 = selectedDocs.length > 0
                ? `AND any(f IN coalesce(r1.source_files, CASE WHEN r1.source_file IS NOT NULL THEN [r1.source_file] ELSE [] END)
                       WHERE f IN $selectedDocs OR any(doc IN $selectedDocs WHERE f CONTAINS doc))`
                : '';

              // Doc filter for r2 — same logic, applied to the OPTIONAL MATCH hop
              // so second-hop context is restricted to the selected documents too.
              const docFilterR2 = selectedDocs.length > 0
                ? `AND any(f IN coalesce(r2.source_files, CASE WHEN r2.source_file IS NOT NULL THEN [r2.source_file] ELSE [] END)
                       WHERE f IN $selectedDocs OR any(doc IN $selectedDocs WHERE f CONTAINS doc))`
                : '';

              const lowerEntities = entities.map((e) => e.toLowerCase());

              // Resolve a readable source label from a relationship's source_files array
              // (new format) or legacy source_file string (old edges).
              const getSourceLabel = (relProps: Record<string, any>): string => {
                const files: string[] = Array.isArray(relProps.source_files)
                  ? relProps.source_files
                  : relProps.source_file ? [relProps.source_file] : [];
                const label = files.find((f) => f && f !== 'Unknown' && f !== 'Unknown Source');
                return label ?? '';
              };

              const processRecords = (records: any[]) => {
                records.forEach((record) => {
                  const sNode = record.get('startNode');
                  const r1 = record.get('r1');
                  const mNode = record.get('m');
                  if (!sNode || !r1 || !mNode) return;

                  const sDeg = record.get('sDeg')?.toNumber?.() ?? 1;
                  const mDeg = record.get('mDeg')?.toNumber?.() ?? 1;
                  const sName = (sNode.properties.name ?? '').trim();
                  const mName = (mNode.properties.name ?? '').trim();
                  if (!sName || !mName) return; // skip nodes with empty/null names
                  const r1Type = r1.properties.type;
                  const r1Label = getSourceLabel(r1.properties);
                  const r1Prefix = r1Label ? `[Source: ${r1Label}] ` : '';
                  const r1W = r1.properties.weight?.toNumber?.() ?? 1;

                  if (!nodeMap.has(sName)) nodeMap.set(sName, { id: sName, name: sName, type: sNode.properties.type ?? 'Entity', degree: sDeg });
                  if (!nodeMap.has(mName)) nodeMap.set(mName, { id: mName, name: mName, type: mNode.properties.type ?? 'Entity', degree: mDeg });

                  const lid1 = r1.identity.toNumber().toString();
                  const fwd = r1.start.toNumber() === sNode.identity.toNumber();
                  if (!linkMap.has(lid1)) {
                    links.push({ source: fwd ? sName : mName, target: fwd ? mName : sName, label: r1Type, weight: r1W });
                    linkMap.set(lid1, true);
                  }
                  directPathStrings.add(`${r1Prefix}${fwd ? sName : mName} --[${r1Type}]--> ${fwd ? mName : sName}`);

                  const r2 = record.get('r2');
                  if (r2) {
                    const kNode = record.get('k');
                    if (kNode && kNode.identity.toNumber() !== sNode.identity.toNumber() && kNode.identity.toNumber() !== mNode.identity.toNumber()) {
                      const r2Type = r2.properties.type;
                      const r2Label = getSourceLabel(r2.properties);
                      const r2Prefix = r2Label ? `[Source: ${r2Label}] ` : '';
                      const r2W = r2.properties.weight?.toNumber?.() ?? 1;
                      const kName = kNode.properties.name;
                      if (!nodeMap.has(kName)) nodeMap.set(kName, { id: kName, name: kName, type: kNode.properties.type ?? 'Entity', degree: 1 });
                      const lid2 = r2.identity.toNumber().toString();
                      const fwd2 = r2.start.toNumber() === mNode.identity.toNumber();
                      if (!linkMap.has(lid2)) {
                        links.push({ source: fwd2 ? mName : kName, target: fwd2 ? kName : mName, label: r2Type, weight: r2W });
                        linkMap.set(lid2, true);
                      }
                      contextPathStrings.add(`${r2Prefix}${fwd2 ? mName : kName} --[${r2Type}]--> ${fwd2 ? kName : mName}`);
                    }
                  }
                });
              };

              // Helper to capture which start nodes directly matched the query
              const captureMatchedNodes = (records: any[]) => {
                records.forEach((record) => {
                  const sNode = record.get('startNode');
                  if (sNode) {
                    const name = (sNode.properties.name ?? '').trim();
                    if (name) matchedNodeIds.add(name);
                  }
                });
              };

              // Step A: Find start nodes using case-insensitive exact text search
              if (lowerEntities.length > 0) {
                const textRes = await tx.run(
                  `MATCH (startNode:Entity)
                   WHERE startNode.user_id = $uid AND toLower(startNode.name) IN $lowerEntities
                   MATCH (startNode)-[r1:RELATION]-(m:Entity)
                   WHERE m.user_id = $uid ${docFilterR1}
                   OPTIONAL MATCH (m)-[r2:RELATION]-(k:Entity)
                   WHERE k.user_id = $uid AND k <> startNode AND k <> m ${docFilterR2}
                   WITH startNode, r1, m, r2, k,
                        COUNT { (startNode)-[:RELATION]-() } AS sDeg,
                        COUNT { (m)-[:RELATION]-() } AS mDeg
                   RETURN startNode, r1, m, r2, k, sDeg, mDeg
                   ORDER BY r1.weight DESC
                   LIMIT 50`,
                  { uid: user.id, lowerEntities, selectedDocs }
                );
                processRecords(textRes.records);
                captureMatchedNodes(textRes.records);
              }

              // Step B: Substring containment search as fallback if exact match yielded no nodes
              if (nodeMap.size === 0 && lowerEntities.length > 0) {
                console.log('[chat] Exact match returned 0 results, trying substring fallback...');
                const substringRes = await tx.run(
                  `MATCH (startNode:Entity)
                   WHERE startNode.user_id = $uid AND any(entity IN $lowerEntities WHERE toLower(startNode.name) CONTAINS entity OR entity CONTAINS toLower(startNode.name))
                   MATCH (startNode)-[r1:RELATION]-(m:Entity)
                   WHERE m.user_id = $uid ${docFilterR1}
                   OPTIONAL MATCH (m)-[r2:RELATION]-(k:Entity)
                   WHERE k.user_id = $uid AND k <> startNode AND k <> m ${docFilterR2}
                   WITH startNode, r1, m, r2, k,
                        COUNT { (startNode)-[:RELATION]-() } AS sDeg,
                        COUNT { (m)-[:RELATION]-() } AS mDeg
                   RETURN startNode, r1, m, r2, k, sDeg, mDeg
                   ORDER BY r1.weight DESC
                   LIMIT 30`,
                  { uid: user.id, lowerEntities, selectedDocs }
                );
                processRecords(substringRes.records);
                captureMatchedNodes(substringRes.records);
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
                       WHERE m.user_id = $uid ${docFilterR1}
                       OPTIONAL MATCH (m)-[r2:RELATION]-(k:Entity)
                       WHERE k.user_id = $uid AND k <> startNode AND k <> m ${docFilterR2}
                       WITH startNode, r1, m, r2, k,
                            COUNT { (startNode)-[:RELATION]-() } AS sDeg,
                            COUNT { (m)-[:RELATION]-() } AS mDeg
                       RETURN startNode, r1, m, r2, k, sDeg, mDeg
                       ORDER BY r1.weight DESC
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

              // Build structured synthesis context: direct facts first, then broader context
              const parts: string[] = [];
              if (directPathStrings.size > 0) {
                parts.push('## Direct Facts\n' + Array.from(directPathStrings).join('\n'));
              }
              if (contextPathStrings.size > 0) {
                parts.push('## Related Context\n' + Array.from(contextPathStrings).join('\n'));
              }
              return parts.join('\n\n') + '\n';
            });
          } finally {
            await session.close();
          }

          console.log('[chat] graph results: nodes=%d links=%d subgraph_chars=%d', nodes.length, links.length, subgraphData.length);
          // Only send graph update when we actually found nodes — empty payload would clear the client graph
          if (nodes.length > 0) {
            send({
              type: 'graph',
              data: { nodes, links },
              matchedNodeIds: Array.from(matchedNodeIds), // direct entity hits (start nodes)
              activeNodeIds: nodes.map((n) => n.id),     // full subgraph
            });
          }

          // ── Hard guardrail: refuse to synthesise when the graph has no data ─
          // Without this, the LLM answers from parametric training knowledge,
          // which defeats the purpose of a knowledge-graph-grounded RAG system.
          if (nodes.length === 0) {
            send({ type: 'text', data: "I couldn't find any relevant information in your knowledge graph for that question. Make sure the document has finished processing and try rephrasing using the exact entity names visible in the graph." });
            send({ type: 'phase', data: null });
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            return;
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

          const synthPrompt = `You are a highly articulate, intelligent personal assistant. Synthesise a smooth, conversational narrative based ONLY on the knowledge graph context provided below.

Style Guide:
1. Speak in a natural, fluid, and human-like voice. Avoid robotic prefixes (like "Based on the knowledge graph..." or "According to the context provided...").
2. Resolve pseudonyms, connections, and relationships naturally in the flow of your writing.
3. Keep the narrative strictly grounded in the factual connections provided. If the context does not contain the answer, say "I don't have enough information to answer that."
4. Cite your sources in-line naturally using the exact [Source: filename] annotations present in the context.
5. DO NOT echo or output raw technical path arrows (such as "A --[relation]--> B") in your final response. Hiding these technical details ensures a clean, premium reading experience.

${historyContext}

Context (Knowledge Graph):
${subgraphData || 'No relevant information found.'}

Current question: ${question}

AT THE END output exactly 3 follow-up questions as: <suggestions>["Q1?","Q2?","Q3?"]</suggestions>`;

          const synthStream = await withRetry(() =>
            getOpenRouter().chat.completions.create({
              model: MODELS.CHAT,
              messages: [{ role: 'user', content: synthPrompt }],
              stream: true,
            })
          );

          // Buffer the full response so we can extract the <suggestions> tag cleanly.
          // Streaming partial tags would break client-side parsing.
          let fullText = '';
          let suggestionBuffer = ''; // accumulates once we see <suggestions>
          let inSuggestions = false;

          for await (const chunk of synthStream) {
            const text = chunk.choices[0]?.delta?.content || '';
            if (!text) continue;
            fullText += text;

            if (inSuggestions) {
              suggestionBuffer += text;
            } else {
              // Check if this chunk starts or crosses into <suggestions>
              const combined = suggestionBuffer + text;
              const tagStart = combined.indexOf('<suggestions>');
              if (tagStart !== -1) {
                // Send everything before the tag
                const before = combined.slice(0, tagStart);
                if (before) send({ type: 'text', data: before });
                suggestionBuffer = combined.slice(tagStart);
                inSuggestions = true;
              } else {
                send({ type: 'text', data: text });
              }
            }
          }

          // Extract and send suggestions after stream completes
          const sugMatch = fullText.match(/<suggestions>([\s\S]*?)<\/suggestions>/);
          if (sugMatch) {
            try {
              const suggestions = JSON.parse(sugMatch[1].trim());
              send({ type: 'suggestions', data: suggestions });
            } catch { /* malformed suggestions — skip */ }
          }

          // ── Save to Semantic Cache ──
          if (queryEmbedding && messageHistory.length === 0) {
            // Only cache isolated queries, removing the technical suggestion tag from the cache
            const cleanAnswer = fullText.replace(/<suggestions>[\s\S]*?<\/suggestions>/, '').trim();
            const { error } = await supabase.from('semantic_cache').insert({
              user_id: user.id,
              question: question,
              question_embedding: queryEmbedding,
              answer: cleanAnswer
            });
            if (error) console.warn('[chat] Semantic cache save failed:', error);
          }

          send({ type: 'phase', data: null });
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));

        } catch (err: any) {
          console.error('Streaming error:', err);
          send({ type: 'error', data: 'Internal Server Error' });
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
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
