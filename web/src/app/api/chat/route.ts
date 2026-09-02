import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import OpenAI from 'openai';
import { driver } from '@/lib/neo4j/neo4j';
import { withRetry } from '@/lib/utils/retry';
import { MODELS } from '@/lib/config/models';
import { embedText, embeddingsEnabled } from '@/lib/embeddings';
import { logLlmUsage, logRequestLatency } from '@/lib/observability/usage-log';
import { classifyQuery } from '@/lib/retrieval/router';
import { checkGroundedness } from '@/lib/retrieval/groundedness';
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

    const requestStarted = Date.now();

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
          // Cosine-similarity nearest-neighbour via the match_semantic_cache
          // RPC (migration 20260902000000) — only cache/hit isolated queries
          // (no conversation history), since history changes what "the same
          // question" should mean.
          if (queryEmbedding && messageHistory.length === 0) {
            const { data: cacheHits, error: cacheErr } = await supabase.rpc('match_semantic_cache', {
              query_embedding: queryEmbedding,
              match_threshold: 0.95,
              match_count: 1,
              user_id_param: user.id,
            });
            if (cacheErr) console.warn('[chat] Semantic cache lookup failed:', cacheErr);

            const cacheHit = cacheHits?.[0];
            if (cacheHit?.answer) {
              send({ type: 'phase', data: 'answering' });
              send({ type: 'text', data: cacheHit.answer });
              send({ type: 'phase', data: null });
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
              return;
            }
          }

          // ── Phase 1: entity extraction ────────────────────────────────────
          send({ type: 'phase', data: 'searching' });

          const client = getOpenRouter();
          const extractStarted = Date.now();

          // Entity extraction and query routing are independent cheap calls — run them together.
          const [extractResult, queryRoute] = await Promise.all([
            withRetry(() =>
              client.chat.completions.create({
                model: MODELS.CHAT,
                messages: [{
                  role: 'user',
                  content: `Extract the key entities from this question as a JSON array of strings. Keep entity names concise and capitalized. Output ONLY the JSON array, no other text. Question: ${question}`,
                }],
              })
            ),
            classifyQuery(client, question, user.id),
          ]);
          logLlmUsage({ route: 'chat', model: MODELS.CHAT, usage: extractResult.usage, latencyMs: Date.now() - extractStarted, userId: user.id });

          // single_hop → 1-hop only, skip vector fallback when literal matching hits.
          // multi_hop → full 3-tier + 2-hop pipeline (unchanged baseline).
          // summarization → treated as multi_hop for now; a real global/community-summary
          // path needs a community-detection layer that doesn't exist yet — future work.
          const singleHop = queryRoute === 'single_hop';
          console.log('[chat] query route: %s', queryRoute);

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
          let nodes: any[] = [];
          const links: any[] = [];
          // matchedNodeIds = direct entity hits (start nodes); activeNodeIds = full subgraph
          const matchedNodeIds = new Set<string>();
          let graphUnavailable = false;

          try {
            const session = driver.session();
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

              // single_hop questions don't need the second-hop expansion — drop the
              // OPTIONAL MATCH and alias r2/k to null so the RETURN shape is unchanged.
              const hop2Match = singleHop
                ? ''
                : `OPTIONAL MATCH (m)-[r2:RELATION]-(k:Entity)
                   WHERE k.user_id = $uid AND k <> startNode AND k <> m ${docFilterR2}`;
              const hop2Vars = singleHop ? 'null AS r2, null AS k' : 'r2, k';

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
                   ${hop2Match}
                   WITH startNode, r1, m, ${hop2Vars},
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
                   ${hop2Match}
                   WITH startNode, r1, m, ${hop2Vars},
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

              // Step C: Vector similarity search (for semantic matches, wrapped safely).
              // single_hop skips it entirely once literal matching already found nodes.
              if (validEmbeddings.length > 0 && !(singleHop && nodeMap.size > 0)) {
                for (const embedding of validEmbeddings) {
                  try {
                    const vectorRes = await tx.run(
                      `CALL db.index.vector.queryNodes('entity_name_embeddings', 3, $embedding)
                       YIELD node AS startNode, score
                       WHERE startNode.user_id = $uid
                       MATCH (startNode)-[r1:RELATION]-(m:Entity)
                       WHERE m.user_id = $uid ${docFilterR1}
                       ${hop2Match}
                       WITH startNode, r1, m, ${hop2Vars},
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
          } catch (graphErr) {
            // Neo4j itself is down/unreachable (a missing vector index is already
            // swallowed per-step above). Fail honestly rather than letting synthesis
            // run on empty context and answer from parametric knowledge.
            console.error('[chat] Neo4j graph search failed:', graphErr);
            graphUnavailable = true;
          }

          if (graphUnavailable) {
            send({ type: 'error', data: 'The knowledge graph is temporarily unavailable. Please try again in a moment.' });
            send({ type: 'phase', data: null });
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            return;
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
                  .map((m: { role: string; content: string }) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 400)}`)
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

          const synthStarted = Date.now();
          const synthStream = await withRetry(() =>
            client.chat.completions.create({
              model: MODELS.CHAT,
              messages: [{ role: 'user', content: synthPrompt }],
              stream: true,
              stream_options: { include_usage: true }, // usage arrives on the final chunk
            })
          );

          // Buffer the full response so we can extract the <suggestions> tag cleanly.
          // Streaming partial tags would break client-side parsing.
          let fullText = '';
          let suggestionBuffer = ''; // accumulates once we see <suggestions>
          let inSuggestions = false;

          let synthUsage: { prompt_tokens?: number; completion_tokens?: number } | undefined;

          for await (const chunk of synthStream) {
            if (chunk.usage) synthUsage = chunk.usage;
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

          logLlmUsage({ route: 'chat', model: MODELS.CHAT, usage: synthUsage, latencyMs: Date.now() - synthStarted, userId: user.id });

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

          // ── Post-generation groundedness check ──
          // Advisory only: the answer has already streamed. null result → skip the
          // event (fail open — the 0-node guardrail above already blocks empty context).
          const verdict = await checkGroundedness(
            client,
            fullText.replace(/<suggestions>[\s\S]*?<\/suggestions>/, '').trim(),
            subgraphData,
            user.id,
          );
          if (verdict) send({ type: 'groundedness', data: verdict });

          send({ type: 'phase', data: null });
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));

        } catch (err: any) {
          console.error('Streaming error:', err);
          send({ type: 'error', data: 'Internal Server Error' });
        } finally {
          // Covers every exit path above (cache hit, rate limit, guardrail, error)
          logRequestLatency('chat', Date.now() - requestStarted, user.id);
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
