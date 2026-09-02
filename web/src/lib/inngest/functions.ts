import { inngest } from './client';
import { supabaseAdmin } from '../supabase/service';
import OpenAI from 'openai';
import { NonRetriableError } from 'inngest';
import { driver } from '../neo4j/neo4j';
import { withRetry } from '../utils/retry';
import { VALID_CLASSES, getTemplate, type ExtractionTemplate } from './templates';
import { MODELS } from '../config/models';
import { embedBatch, embeddingsEnabled, DIMENSIONS } from '../embeddings';

/**
 * Normalises an extracted entity name to prevent trivial duplicates:
 *   - Collapses multiple spaces to one
 *   - Converts smart quotes / curly apostrophes to ASCII equivalents
 *   - Converts em/en dashes to ASCII hyphen
 *   - Strips zero-width characters
 * Does NOT change casing (LLM already capitalises correctly per the prompt,
 * and lowercasing would break proper-noun casing like "iOS", "McKinsey").
 */
function normaliseEntityName(name: string): string {
  return name
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/['']/g, "'")
    .replace(/[""]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/[​-‍﻿]/g, '');
}

// Lazy OpenRouter client — instantiated per call so a missing env var
// doesn't crash the module at import time (build-time safety).
function getOpenRouter(): OpenAI {
  return new OpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: process.env.OPENROUTER_API_KEY || 'placeholder',
  });
}

export interface GraphTriple {
  source:      string;
  source_type: string;
  relation:    string;
  target:      string;
  target_type: string;
  // Provenance: "filename#charStart-charEnd" into the converted document
  // text — set by our own code after extraction, never by the LLM, so an
  // edge is always traceable back to the exact source excerpt it came from.
  source_chunk?: string;
}

/**
 * Converts any supported file to Markdown via the markitdown sidecar
 * (services/markitdown-service) — one converter for every format instead of
 * a parser per extension. Markdown output (esp. tables) is more legible to
 * the extraction LLM than a raw text dump.
 */
async function convertToMarkdown(buffer: Buffer, filename: string): Promise<string> {
  const serviceUrl = process.env.MARKITDOWN_SERVICE_URL || 'http://localhost:8001';
  const serviceToken = process.env.MARKITDOWN_SERVICE_TOKEN;

  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(buffer)]), filename);

  let res: Response;
  try {
    res = await fetch(`${serviceUrl}/convert`, {
      method: 'POST',
      headers: serviceToken ? { 'x-service-token': serviceToken } : undefined,
      body: form,
    });
  } catch (err: any) {
    // Network/connection failure — retriable, the sidecar may just be cold-starting.
    throw new Error(`markitdown-service unreachable: ${err?.message ?? 'unknown error'}`);
  }

  if (res.status === 422) {
    const body = await res.json().catch(() => ({}));
    throw new NonRetriableError(body.detail ?? 'markitdown-service could not convert this file.');
  }
  if (!res.ok) {
    throw new Error(`markitdown-service error ${res.status}: ${await res.text().catch(() => '')}`);
  }

  const { markdown } = await res.json();
  return markdown ?? '';
}

/** Split text into overlapping chunks so context bleeds across boundaries.
 *
 * Size is intentionally conservative (1 500 chars ≈ 375 tokens of input).
 * Dense structured files (numbered lists, member directories, data tables)
 * can generate 10 000+ tokens of JSON output from a single 4 000-char chunk,
 * which silently truncates on models with ≤ 4 096 output tokens.
 * Smaller input chunks → manageable output → no silent parse failures.
 */
export interface TextChunk {
  text:  string;
  start: number;
  end:   number;
}

export function chunkText(text: string, size = 1_500, overlap = 200): TextChunk[] {
  if (text.length <= size) return [{ text, start: 0, end: text.length }];
  const chunks: TextChunk[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + size, text.length);
    chunks.push({ text: text.slice(start, end), start, end });
    if (end === text.length) break;
    start += size - overlap;
  }
  return chunks;
}

/**
 * Phase 1 — CLASSIFY.
 *
 * Injection-safety guarantee: the LLM can only output one token from our
 * closed enum (VALID_CLASSES). Any injection attempt in the document just
 * produces a wrong or unrecognised classification, which falls back to
 * "general". The document NEVER touches a template — templates are static
 * code selected in pure TypeScript after this call returns.
 */
export async function classifyDocument(sample: string): Promise<string> {
  const classList = [...VALID_CLASSES].join(', ');
  try {
    const res = await withRetry(() =>
      getOpenRouter().chat.completions.create({
        model: MODELS.DISCOVERY,
        messages: [
          {
            role: 'system',
            content:
              `Classify the document into exactly one of the following categories and output ONLY that word — nothing else:\n${classList}`,
          },
          { role: 'user', content: `Document sample (first 500 chars):\n\n${sample.slice(0, 500)}` },
        ],
        max_tokens: 10,
      }),
    );
    const raw = (res.choices[0]?.message?.content ?? '').trim().toLowerCase().replace(/\W/g, '_');
    // Validate against our enum — any unexpected output → 'general'
    return VALID_CLASSES.has(raw) ? raw : 'general';
  } catch {
    return 'general';
  }
}

// Forces the extraction call to return well-formed JSON instead of relying on
// prompt instructions + regex-stripping markdown fences. Not every OpenRouter
// provider honours strict json_schema mode, so we try it first and fall back
// to the much more broadly supported json_object mode (guarantees syntactically
// valid JSON, just not the exact shape) rather than hard-failing the chunk.
const EXTRACTION_SCHEMA = {
  type: 'object',
  properties: {
    entities: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, type: { type: 'string' } },
        required: ['name', 'type'],
        additionalProperties: false,
      },
    },
    relations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          source:      { type: 'string' },
          source_type: { type: 'string' },
          relation:    { type: 'string' },
          target:      { type: 'string' },
          target_type: { type: 'string' },
        },
        required: ['source', 'source_type', 'relation', 'target', 'target_type'],
        additionalProperties: false,
      },
    },
  },
  required: ['entities', 'relations'],
  additionalProperties: false,
};

async function extractionCompletion(systemPrompt: string, chunk: string) {
  const messages = [
    { role: 'system' as const, content: systemPrompt },
    { role: 'user' as const,   content: chunk },
  ];
  try {
    return await withRetry(() =>
      getOpenRouter().chat.completions.create({
        model: MODELS.EXTRACTION,
        messages,
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'graph_extraction', strict: true, schema: EXTRACTION_SCHEMA },
        } as any,
      }),
    );
  } catch (err: any) {
    console.warn('[ingest] json_schema response_format rejected, falling back to json_object:', err?.message);
    return await withRetry(() =>
      getOpenRouter().chat.completions.create({
        model: MODELS.EXTRACTION,
        messages,
        response_format: { type: 'json_object' },
      }),
    );
  }
}

/**
 * Phase 2+3 — EXTRACT (per chunk).
 *
 * The system prompt is built entirely from our static template (selected by
 * classifyDocument). The document chunk is ONLY in the user message.
 * Template content is never influenced by the document.
 */
export async function extractChunk(
  chunk: string,
  template: ExtractionTemplate,
  registry: Array<{ name: string; type: string }>,
): Promise<{ entities: Array<{ name: string; type: string }>; triples: GraphTriple[] }> {
  // Format registry compactly; cap at 200 entries to control prompt size
  const regSlice = registry.slice(-200);
  const registryLine = regSlice.length
    ? `\nKNOWN ENTITIES — always use these exact canonical names, never create an alias:\n${
        regSlice.map((e) => `${e.name} (${e.type})`).join(', ')
      }\n`
    : '';

  // System prompt is 100% our code — template is static, never LLM-generated
  const systemPrompt =
    `You extract a comprehensive knowledge graph from a ${template.label} document.\n\n` +
    `ENTITY TYPES: ${template.entityTypes.join(', ')}\n\n` +
    `RELATIONSHIP VERBS: ${template.relationVerbs.join(', ')}\n` +
    `(You may coin new UPPER_CASE verbs for relationships not on this list, but prefer the list above.)\n\n` +
    `EXTRACTION RULES — follow every rule precisely:\n` +
    template.extractionRules.map((r, i) => `${i + 1}. ${r}`).join('\n') +
    `\n${registryLine}\n` +
    `Output ONLY a JSON object (no markdown) with exactly two keys:\n` +
    `1. "entities": array of { "name": string, "type": string }\n` +
    `   - Include EVERY distinct entity mentioned — be exhaustive, not selective\n` +
    `   - Always use the most complete canonical form (full name, not pronoun or abbreviation)\n` +
    `   - If an entity matches a KNOWN ENTITY above, use that exact canonical name\n` +
    `   - Choose the best-fitting type from the ENTITY TYPES list\n` +
    `2. "relations": array of { "source": string, "source_type": string, "relation": string, "target": string, "target_type": string }\n` +
    `   - Extract EVERY relationship — explicit and implied\n` +
    `   - source and target must be different entities from "entities" or KNOWN ENTITIES\n` +
    `   - "relation" must be UPPER_CASE\n` +
    `   - Direction: grammatical subject → "source", object → "target"`;

  const res = await extractionCompletion(systemPrompt, chunk);

  const raw = res.choices[0]?.message?.content ?? '{}';
  const cleaned = raw.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);

  let parsed: any = {};
  try {
    parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(cleaned);
  } catch {
    return { entities: [], triples: [] };
  }

  // Entities
  const entities: Array<{ name: string; type: string }> = (Array.isArray(parsed.entities) ? parsed.entities : [])
    .map((e: any) => ({
      name: normaliseEntityName(String(e?.name ?? '')),
      type: String(e?.type ?? 'Entity').trim() || 'Entity',
    }))
    .filter((e: { name: string; type: string }) => e.name.length >= 2 && !/^\d+$/.test(e.name));

  // Merge registry + chunk entities into a lookup for type resolution
  const entityTypeLookup = new Map<string, string>();
  for (const e of [...regSlice, ...entities]) {
    entityTypeLookup.set(e.name.toLowerCase(), e.type);
  }

  // Relations
  const triples: GraphTriple[] = (Array.isArray(parsed.relations) ? parsed.relations : [])
    .map((r: any) => ({
      source:      normaliseEntityName(String(r?.source      ?? '')),
      source_type: String(r?.source_type ?? '').trim() || entityTypeLookup.get(normaliseEntityName(String(r?.source ?? '')).toLowerCase()) || 'Entity',
      relation:    normaliseEntityName(String(r?.relation    ?? '')).toUpperCase().replace(/\s+/g, '_'),
      target:      normaliseEntityName(String(r?.target      ?? '')),
      target_type: String(r?.target_type ?? '').trim() || entityTypeLookup.get(normaliseEntityName(String(r?.target ?? '')).toLowerCase()) || 'Entity',
    }))
    .filter((t: GraphTriple) =>
      t.source.length   >= 2 &&
      t.target.length   >= 2 &&
      t.relation.length >= 2 &&
      t.source          !== t.target &&
      !/^\d+$/.test(t.source) &&
      !/^\d+$/.test(t.target),
    );

  return { entities, triples };
}

/**
 * Pre-write alias normalisation.
 * If all tokens of a shorter name appear in a longer name, the shorter name
 * is an alias and gets replaced everywhere with the canonical longer form.
 * Example: "Armstrong" → "Neil Armstrong" (["armstrong"] ⊆ ["neil","armstrong"])
 */
function resolveAliases(triples: GraphTriple[]): GraphTriple[] {
  const allNames = [...new Set(triples.flatMap((t) => [t.source, t.target]))];

  const aliasMap = new Map<string, string>();
  for (const candidate of allNames) {
    if (aliasMap.has(candidate)) continue; // already resolved
    const cTokens = candidate.toLowerCase().split(/\s+/).filter(Boolean);
    let bestLen = 0;
    let bestName = '';
    for (const full of allNames) {
      if (full === candidate) continue;
      const fTokens = full.toLowerCase().split(/\s+/).filter(Boolean);
      if (fTokens.length <= cTokens.length) continue;
      if (cTokens.every((t) => fTokens.includes(t)) && fTokens.length > bestLen) {
        bestLen = fTokens.length;
        bestName = full;
      }
    }
    if (bestName) aliasMap.set(candidate, bestName);
  }

  if (aliasMap.size === 0) return triples;

  const seen = new Set<string>();
  const result: GraphTriple[] = [];
  for (const t of triples) {
    const src = aliasMap.get(t.source) ?? t.source;
    const tgt = aliasMap.get(t.target) ?? t.target;
    if (src === tgt) continue;
    const key = `${src}|${t.relation}|${tgt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ ...t, source: src, target: tgt });
  }
  return result;
}

// ── Main Inngest function ──────────────────────────────────────────────────────
export const processDocument = inngest.createFunction(
  {
    id: 'process-document',
    retries: 2,
    triggers: [{ event: 'document.process' }],
    // Limit to 3 concurrent jobs per user so Neo4j and OpenRouter aren't
    // hammered when someone uploads many files at once.
    concurrency: { limit: 3, key: 'event.data.userId' },
    // Without this, a hung OpenRouter call (network stall, not an error) can
    // leave a document stuck in "Processing" forever with no retry and no
    // visible failure. 10 minutes covers the largest documents (13 chunks)
    // with real margin even sequentially; comfortably more with batching.
    timeouts: { finish: '10m' },
  },
  async ({ event, step }: { event: { data: { documentId: string; filePath: string; userId: string; filename: string } }; step: any }) => {
    const { documentId, filePath, userId, filename } = event.data;

    try {
      // ── Step 1: Download ───────────────────────────────────────────────────
      const fileData = await step.run('download-file', async () => {
        // Status update inside the step — only runs once even on retries
        await supabaseAdmin.from('documents').update({ processing_step: 'downloading' }).eq('id', documentId);

        const { data, error } = await supabaseAdmin.storage.from('documents').download(filePath);
        if (error || !data) throw new Error(`Failed to download file: ${error?.message}`);
        const buffer = Buffer.from(await data.arrayBuffer());
        const ext = filename?.split('.').pop()?.toLowerCase() ?? '';
        return { buffer: buffer.toString('base64'), ext };
      });

      // ── Step 2: Extract — routed by file type ──────────────────────────────
      const extractedData = await step.run('extract-graph', async () => {
        await supabaseAdmin.from('documents').update({ processing_step: 'extracting' }).eq('id', documentId);

        const rawBuffer = Buffer.from(fileData.buffer, 'base64');
        const ext = fileData.ext;

        // ── Route by accepted file type ───────────────────────────────────────
        const SUPPORTED = new Set(['csv', 'xlsx', 'xls', 'docx', 'txt', 'pdf']);
        if (!SUPPORTED.has(ext)) {
          throw new Error(
            `Unsupported file type ".${ext}". Accepted formats: .docx, .txt, .csv, .xlsx, .xls`,
          );
        }

        // Every format goes through markitdown → Markdown text → 3-stage LLM
        // pipeline. Structured formats (csv/xlsx) come back as Markdown
        // tables, which the extraction LLM reads directly.
        const rawText = await convertToMarkdown(rawBuffer, filename);
        console.log(`[ingest] ${ext.toUpperCase()} → markdown — ${rawText.length} chars`);

        // Near-zero output means a scanned/image-only PDF or an empty file —
        // fail fast, don't retry.
        if (rawText.trim().length < 100) {
          throw new NonRetriableError(
            `Could not extract meaningful content from this file (only ${rawText.trim().length} characters). ` +
            'It may be scanned/image-only, empty, or corrupt.',
          );
        }

        // Cap at 20 000 chars (~13 chunks) — controls token spend per document
        const MAX_CHARS = 20_000;
        const text = rawText.slice(0, MAX_CHARS);
        if (rawText.length > MAX_CHARS) {
          console.warn(`[ingest] Document truncated from ${rawText.length} to ${MAX_CHARS} chars`);
        }

        // ── Phase 1: Classify document (one tiny call, closed enum output) ──
        // Injection-safe: LLM outputs ONE word from our enum. Document content
        // never writes or modifies a template — templates are static code below.
        const docClass = await classifyDocument(text);
        const template  = getTemplate(docClass);
        console.log(`[ingest] Classified as "${docClass}" → template: ${template.label}`);

        // ── Phase 2+3: Chunk → extract using static domain template ──────────
        const chunks = chunkText(text);
        console.log(`[ingest] Processing ${chunks.length} chunk(s) with ${template.entityTypes.length} entity types, ${template.extractionRules.length} extraction rules`);

        const entityRegistry: Array<{ name: string; type: string }> = [];
        const allTriples: GraphTriple[] = [];

        // Chunks within a batch run concurrently (real latency win — one
        // sequential LLM round-trip per chunk was the biggest lever in this
        // pipeline); the registry only updates BETWEEN batches, so chunks in
        // the same batch don't see each other's freshly-extracted entities.
        // Full parallelism would drop that cross-chunk registry entirely —
        // resolveAliases() below still reconciles casing/alias drift after
        // the fact, so this is a deliberate latency/consistency tradeoff,
        // not a correctness bug.
        const CHUNK_CONCURRENCY = 4;
        for (let batchStart = 0; batchStart < chunks.length; batchStart += CHUNK_CONCURRENCY) {
          const batch = chunks.slice(batchStart, batchStart + CHUNK_CONCURRENCY);
          const batchResults = await Promise.all(
            batch.map(async (chunk, offset) => {
              const i = batchStart + offset;
              try {
                const { entities, triples } = await extractChunk(chunk.text, template, entityRegistry);
                const sourceChunk = `${filename}#${chunk.start}-${chunk.end}`;
                console.log(`[ingest] Chunk ${i + 1}/${chunks.length} → ${entities.length} entities, ${triples.length} relations`);
                return { entities, triples: triples.map((t) => ({ ...t, source_chunk: sourceChunk })) };
              } catch (err: any) {
                console.warn(`[ingest] Chunk ${i + 1} failed, skipping: ${err?.message}`);
                return { entities: [] as Array<{ name: string; type: string }>, triples: [] as GraphTriple[] };
              }
            }),
          );

          for (const { entities, triples } of batchResults) {
            for (const entity of entities) {
              if (entity.name.length >= 2 && !entityRegistry.some(
                (e) => e.name.toLowerCase() === entity.name.toLowerCase(),
              )) {
                entityRegistry.push(entity);
              }
            }
            allTriples.push(...triples);
          }
        }

        // ── Pre-write alias resolution ────────────────────────────────────
        // 1. Collapse short-form aliases ("Armstrong" → "Neil Armstrong")
        const aliasResolved = resolveAliases(allTriples);

        // 2. Case-fold: if the same name appears with different casing across
        //    chunks (e.g. "Neil Armstrong" vs "neil armstrong"), unify to the
        //    first-seen casing so the MERGE hits one node instead of two.
        const caseMap = new Map<string, string>();
        for (const t of aliasResolved) {
          if (!caseMap.has(t.source.toLowerCase())) caseMap.set(t.source.toLowerCase(), t.source);
          if (!caseMap.has(t.target.toLowerCase())) caseMap.set(t.target.toLowerCase(), t.target);
        }
        const resolved = aliasResolved
          .map((t) => ({
            ...t,
            source: caseMap.get(t.source.toLowerCase()) ?? t.source,
            target: caseMap.get(t.target.toLowerCase()) ?? t.target,
          }))
          .filter((t) => t.source !== t.target);

        console.log(`[ingest] After alias + case resolution: ${resolved.length} triples (was ${allTriples.length})`);

        if (resolved.length === 0) {
          console.warn('[ingest] Extraction produced 0 triples — document will be marked Completed with 0 entities');
        }

        return resolved;
      });

      console.log(`[ingest] Extracted ${extractedData.length} triples from "${filename}"`);

      // ── Early abort if extraction produced 0 triples ───────────────────────
      // This prevents Step 4 (update-status) from overwriting a 'Failed' status
      // with 'Completed', which was the root cause of the 'Completed with 0 entities' bug.
      if (!extractedData.length) {
        await step.run('mark-failed-empty', async () => {
          await supabaseAdmin
            .from('documents')
            .update({ status: 'Failed', processing_step: null })
            .eq('id', documentId);
        });
        return { success: false, reason: 'no triples extracted' };
      }

      // ── Step 3: Save to Neo4j ──────────────────────────────────────────────
      // Schema init (index + constraint) is handled once in neo4j.ts on cold
      // start — not repeated here on every file.
      await step.run('save-to-neo4j', async () => {
        await supabaseAdmin.from('documents').update({ processing_step: 'saving' }).eq('id', documentId);

        const session = driver.session();
        try {
          await session.executeWrite(async (tx: any) => {
            await tx.run(
              `UNWIND $batch AS item
               MERGE (s:Entity {name: item.source, user_id: $userId})
               ON CREATE SET s.type = item.sourceType, s.created_at = datetime()
               ON MATCH  SET s.type = CASE WHEN s.type = 'Entity' THEN item.sourceType ELSE s.type END
               MERGE (t:Entity {name: item.target, user_id: $userId})
               ON CREATE SET t.type = item.targetType, t.created_at = datetime()
               ON MATCH  SET t.type = CASE WHEN t.type = 'Entity' THEN item.targetType ELSE t.type END
               MERGE (s)-[r:RELATION {type: item.relation, user_id: $userId}]->(t)
               ON CREATE SET r.weight = 1, r.created_at = datetime(),
                            r.source_files  = [$filename],
                            r.source_chunks = CASE WHEN item.sourceChunk IS NULL THEN [] ELSE [item.sourceChunk] END
               ON MATCH  SET r.weight = r.weight + 1,
                            r.source_files = CASE WHEN $filename IN coalesce(r.source_files, [])
                                             THEN coalesce(r.source_files, [])
                                             ELSE coalesce(r.source_files, []) + [$filename] END,
                            r.source_chunks = CASE WHEN item.sourceChunk IS NULL OR item.sourceChunk IN coalesce(r.source_chunks, [])
                                             THEN coalesce(r.source_chunks, [])
                                             ELSE coalesce(r.source_chunks, []) + [item.sourceChunk] END`,
              {
                batch: extractedData.map((item: GraphTriple) => ({
                  source:      item.source,
                  sourceType:  item.source_type,
                  target:      item.target,
                  targetType:  item.target_type,
                  relation:    item.relation,
                  sourceChunk: item.source_chunk ?? null,
                })),
                userId,
                filename: filename || 'Unknown Source',
              },
            );
          });
        } finally {
          await session.close();
        }

        return { inserted: extractedData.length };
      });

      // ── Step 4: Mark complete — graph is now visible to the user ──────────
      await step.run('update-status', async () => {
        const uniqueEntities = new Set(
          extractedData.flatMap((d: GraphTriple) => [d.source, d.target]),
        );
        await supabaseAdmin.from('documents').update({
          processing_step: null,
          status:          'Completed',
          entity_count:    uniqueEntities.size,
          relation_count:  extractedData.length,
        }).eq('id', documentId);
      });

      // ── Step 5: Embeddings ────────────────────────────────────────────────
      // Activated automatically when OPENAI_API_KEY (or EMBEDDING_API_KEY) is
      // set.  Falls back gracefully when no key is present — exact-match +
      // substring search in the chat route still work without embeddings.
      await step.run('generate-embeddings', async () => {
        if (!embeddingsEnabled) {
          return { embedded: 0, status: 'skipped — set OPENAI_API_KEY to enable' };
        }

        // Only embed entity names that don't already have an embedding stored.
        const uniqueNames: string[] = [...new Set(
          (extractedData as GraphTriple[]).flatMap((d) => [d.source, d.target]),
        )];

        const session = driver.session();
        try {
          // Check which nodes already have embeddings so we don't re-embed them
          const existing = await session.executeRead((tx: any) =>
            tx.run(
              `MATCH (n:Entity {user_id: $userId})
               WHERE n.name IN $names AND n.embedding IS NOT NULL
               RETURN n.name AS name`,
              { userId, names: uniqueNames },
            ),
          );
          const alreadyEmbedded = new Set(existing.records.map((r: any) => r.get('name') as string));
          const toEmbed = uniqueNames.filter((n) => !alreadyEmbedded.has(n));

          if (toEmbed.length === 0) return { embedded: 0, status: 'all already embedded' };

          const vectors = await embedBatch(toEmbed);
          const pairs = toEmbed
            .map((name, i) => ({ name, vector: vectors[i] }))
            .filter((p) => p.vector !== null);

          if (pairs.length === 0) return { embedded: 0, status: 'embedding API returned no vectors' };

          await session.executeWrite((tx: any) =>
            Promise.all(
              pairs.map((p) =>
                tx.run(
                  'MATCH (n:Entity {name: $name, user_id: $userId}) SET n.embedding = $embedding',
                  { name: p.name, userId, embedding: p.vector },
                ),
              ),
            ),
          );

          console.log(`[ingest] Embedded ${pairs.length} entities (model dim=${DIMENSIONS})`);
          return { embedded: pairs.length };
        } finally {
          await session.close();
        }
      });

      return { success: true, relationsExtracted: extractedData.length };

    } catch (err: any) {
      console.error(`[ingest] FAILED for ${documentId}:`, err?.message ?? err);
      try {
        await supabaseAdmin
          .from('documents')
          .update({ status: 'Failed', processing_step: null })
          .eq('id', documentId);
      } catch { /* non-fatal */ }
      throw err;
    }
  },
);
