// @ts-nocheck
import { inngest } from './client';
import { supabaseAdmin } from '../supabase/service';
import OpenAI from 'openai';
import { driver } from '../neo4j/neo4j';
import * as mammoth from 'mammoth';
import Papa from 'papaparse';

// Lazy client — instantiated at call time so missing env vars don't crash the build
function getOpenRouter() {
  return new OpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: process.env.OPENROUTER_API_KEY || 'placeholder',
  });
}


// ── Relationship column keyword map ────────────────────────────────────────────
// Keys are lowercase substrings to match against CSV/JSON column headers.
const REL_COLUMN_MAP: Record<string, { relation: string; sourceType: string; targetType: string }> = {
  father:       { relation: 'child of',    sourceType: 'Person',       targetType: 'Person' },
  mother:       { relation: 'child of',    sourceType: 'Person',       targetType: 'Person' },
  parent:       { relation: 'child of',    sourceType: 'Person',       targetType: 'Person' },
  spouse:       { relation: 'married to',  sourceType: 'Person',       targetType: 'Person' },
  husband:      { relation: 'married to',  sourceType: 'Person',       targetType: 'Person' },
  wife:         { relation: 'married to',  sourceType: 'Person',       targetType: 'Person' },
  partner:      { relation: 'partner of',  sourceType: 'Person',       targetType: 'Person' },
  child:        { relation: 'parent of',   sourceType: 'Person',       targetType: 'Person' },
  children:     { relation: 'parent of',   sourceType: 'Person',       targetType: 'Person' },
  son:          { relation: 'parent of',   sourceType: 'Person',       targetType: 'Person' },
  daughter:     { relation: 'parent of',   sourceType: 'Person',       targetType: 'Person' },
  sibling:      { relation: 'sibling of',  sourceType: 'Person',       targetType: 'Person' },
  brother:      { relation: 'sibling of',  sourceType: 'Person',       targetType: 'Person' },
  sister:       { relation: 'sibling of',  sourceType: 'Person',       targetType: 'Person' },
  manager:      { relation: 'reports to',  sourceType: 'Person',       targetType: 'Person' },
  reports_to:   { relation: 'reports to',  sourceType: 'Person',       targetType: 'Person' },
  supervisor:   { relation: 'supervised by', sourceType: 'Person',     targetType: 'Person' },
  employer:     { relation: 'works at',    sourceType: 'Person',       targetType: 'Organization' },
  company:      { relation: 'works at',    sourceType: 'Person',       targetType: 'Organization' },
  organization: { relation: 'member of',   sourceType: 'Person',       targetType: 'Organization' },
  owns:         { relation: 'owns',        sourceType: 'Person',       targetType: 'Entity' },
  owned_by:     { relation: 'owned by',    sourceType: 'Entity',       targetType: 'Person' },
  founded_by:   { relation: 'founded by',  sourceType: 'Organization', targetType: 'Person' },
  located_in:   { relation: 'located in',  sourceType: 'Entity',       targetType: 'Location' },
  location:     { relation: 'located in',  sourceType: 'Entity',       targetType: 'Location' },
  city:         { relation: 'born in',     sourceType: 'Person',       targetType: 'Location' },
  country:      { relation: 'from',        sourceType: 'Person',       targetType: 'Location' },
};

const NAME_SYNONYMS = ['name', 'fullname', 'full_name', 'person', 'entity', 'title', 'label', 'person_name'];

interface GraphTriple {
  source: string;
  source_type: string;
  relation: string;
  target: string;
  target_type: string;
}

/**
 * CSV → graph triples, no LLM.
 * Detects the entity column by name, then maps relationship columns via REL_COLUMN_MAP.
 * Handles multi-value cells separated by ; or |
 */
function parseCsvToGraph(buffer: Buffer): GraphTriple[] {
  const { data, meta } = Papa.parse(buffer.toString('utf8'), {
    header: true, skipEmptyLines: true, dynamicTyping: false,
  });
  if (!data.length || !meta.fields?.length) return [];

  const headers = meta.fields;
  const nameCol =
    headers.find(h => NAME_SYNONYMS.includes(h.toLowerCase().replace(/[^a-z_]/g, ''))) ?? headers[0];

  const triples: GraphTriple[] = [];
  for (const row of data as Record<string, string>[]) {
    const source = String(row[nameCol] ?? '').trim();
    if (!source) continue;

    for (const header of headers) {
      if (header === nameCol) continue;
      const colKey = header.toLowerCase().replace(/[^a-z_]/g, '');
      const relDef = Object.entries(REL_COLUMN_MAP).find(([k]) => colKey.includes(k))?.[1];
      if (!relDef) continue;

      const rawVal = String(row[header] ?? '').trim();
      if (!rawVal) continue;

      // Multi-value: "Alice; Bob | Carol"
      for (const target of rawVal.split(/[;|]/).map(v => v.trim()).filter(Boolean)) {
        if (target !== source) {
          triples.push({ source, source_type: relDef.sourceType, relation: relDef.relation, target, target_type: relDef.targetType });
        }
      }
    }
  }
  return triples;
}

/**
 * JSON → graph triples, no LLM.
 * Unwraps common envelope keys (data/items/results) then treats each
 * object in the array as an entity, mapping keys via REL_COLUMN_MAP.
 */
function parseJsonToGraph(buffer: Buffer): GraphTriple[] {
  let parsed: any;
  try { parsed = JSON.parse(buffer.toString('utf8')); } catch { return []; }

  const arr: any[] = Array.isArray(parsed)
    ? parsed
    : (parsed.data ?? parsed.items ?? parsed.results ?? parsed.nodes ?? Object.values(parsed)[0]);
  if (!Array.isArray(arr) || !arr.length) return [];

  const keys = Object.keys(arr[0]);
  const nameKey = keys.find(k => NAME_SYNONYMS.includes(k.toLowerCase())) ?? keys[0];

  const triples: GraphTriple[] = [];
  for (const item of arr) {
    const source = String(item[nameKey] ?? '').trim();
    if (!source) continue;

    for (const key of keys) {
      if (key === nameKey) continue;
      const colKey = key.toLowerCase().replace(/[^a-z_]/g, '');
      const relDef = Object.entries(REL_COLUMN_MAP).find(([k]) => colKey.includes(k))?.[1];
      if (!relDef) continue;

      const val = item[key];
      const targets = Array.isArray(val)
        ? val.map(String)
        : String(val ?? '').split(/[;|,]/).map(v => v.trim()).filter(Boolean);

      for (const target of targets) {
        if (target && target !== source) {
          triples.push({ source, source_type: relDef.sourceType, relation: relDef.relation, target, target_type: relDef.targetType });
        }
      }
    }
  }
  return triples;
}

// ── Retry / embed helpers ──────────────────────────────────────────────────────
async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 3, baseDelayMs = 1500): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try { return await fn(); } catch (err: any) {
      if (attempt === maxAttempts) throw err;
      await new Promise((r) => setTimeout(r, baseDelayMs * Math.pow(2, attempt - 1)));
      lastError = err;
    }
  }
  throw lastError;
}

async function embedEntity(model: any, entity: string): Promise<number[] | null> {
  try {
    return await withRetry(async () => {
      const res = await model.embedContent(entity);
      return res.embedding.values;
    });
  } catch (err: any) {
    console.error(`[ingest] Failed to embed "${entity}":`, err?.message);
    return null;
  }
}

async function embedEntitiesBatch(model: any, entities: string[]): Promise<(number[] | null)[]> {
  try {
    return await withRetry(async () => {
      const res = await model.batchEmbedContents({
        requests: entities.map((e) => ({
          model: 'models/text-embedding-004',
          content: { parts: [{ text: e }] },
        })),
      });
      return res.embeddings.map((emb: any) => emb.values || null);
    });
  } catch (err: any) {
    // Skip sequential fallback — 100 individual calls would stall the function.
    // Embeddings are optional; return nulls and continue.
    console.warn(`[ingest] Batch embed failed, skipping embeddings for this batch:`, err?.message);
    return entities.map(() => null);
  }
}

async function setStep(documentId: string, step: string | null) {
  await supabaseAdmin.from('documents').update({ processing_step: step }).eq('id', documentId);
}

const VALID_ENTITY_TYPES = new Set(['Person', 'Organization', 'Location', 'Event', 'Concept', 'Technology', 'Entity']);

// ── Extraction prompt ──────────────────────────────────────────────────────────
const EXTRACT_PROMPT = `Analyze the following document and extract all key entities and their relationships.
Output a JSON array of objects. Each object MUST have exactly these string properties:
  - "source": entity name, 2–100 characters, no leading/trailing spaces, capitalized (e.g. "Alice Smith", "Apple Inc")
  - "source_type": MUST be one of exactly: Person, Organization, Location, Event, Concept, Technology, Entity
  - "relation": relationship phrase, 2–50 characters, lowercase (e.g. "works at", "founded", "located in")
  - "target": entity name, same rules as source
  - "target_type": MUST be one of exactly: Person, Organization, Location, Event, Concept, Technology, Entity
Rules: source and target must be different. No empty strings, no pure numbers, no punctuation-only names.
Extract as many meaningful relationships as possible.`;

// ── Main Inngest function ──────────────────────────────────────────────────────
export const processDocument = inngest.createFunction(
  { id: 'process-document', retries: 2, triggers: [{ event: 'document.process' }] },
  async ({ event, step }: any) => {
    const { documentId, filePath, userId, filename } = event.data;

    try {
      // 1. Download
      await setStep(documentId, 'downloading');
      const fileData = await step.run('download-file', async () => {
        const { data, error } = await supabaseAdmin.storage.from('documents').download(filePath);
        if (error || !data) throw new Error(`Failed to download file: ${error?.message}`);
        const buffer = Buffer.from(await data.arrayBuffer());
        const ext = filename?.split('.').pop()?.toLowerCase() || '';
        return { buffer: buffer.toString('base64'), ext };
      });

      // 2. Extract — route by file type
      await setStep(documentId, 'extracting');
      const extractedData = await step.run('extract-graph', async () => {
        const rawBuffer = Buffer.from(fileData.buffer, 'base64');
        const ext = fileData.ext;

        // ── Structured files: parse directly, zero Gemini calls ──────────────
        if (ext === 'csv') {
          console.log(`[ingest] CSV detected — parsing directly (no Gemini)`);
          return parseCsvToGraph(rawBuffer);
        }
        if (ext === 'json') {
          console.log(`[ingest] JSON detected — parsing directly (no Gemini)`);
          return parseJsonToGraph(rawBuffer);
        }

        // ── Unstructured files: extract text first, then Gemini ───────────────
        let promptInput: any;

        if (['png', 'jpg', 'jpeg', 'webp'].includes(ext)) {
          // Images: send as base64 data URL to Qwen vision
          const mimeType = `image/${ext === 'jpg' ? 'jpeg' : ext}`;
          promptInput = { type: 'image_url', image_url: { url: `data:${mimeType};base64,${fileData.buffer}` } };
          console.log(`[ingest] Image (${ext}) — sending to Qwen vision`);
        } else if (ext === 'pdf') {
          // PDF: extract text with pdf-parse (dynamic import — static import crashes at module init)
          try {
            const { default: pdfParse } = await import('pdf-parse');
            const pdfData = await pdfParse(rawBuffer);
            promptInput = pdfData.text;
            console.log(`[ingest] PDF — extracted ${pdfData.text.length} chars of text`);
          } catch (pdfErr: any) {
            console.warn(`[ingest] pdf-parse failed (${pdfErr.message}), falling back to base64`);
            promptInput = { inlineData: { data: fileData.buffer, mimeType: 'application/pdf' } };
          }
        } else if (ext === 'docx') {
          const result = await mammoth.extractRawText({ buffer: rawBuffer });
          promptInput = result.value;
          console.log(`[ingest] DOCX — extracted ${result.value.length} chars`);
        } else {
          promptInput = rawBuffer.toString('utf8');
          console.log(`[ingest] Text (${ext}) — ${promptInput.length} chars`);
        }

        // Call Qwen3.5 Plus via OpenRouter (handles text + vision)
        const userContent = typeof promptInput === 'string'
          ? promptInput
          : [{ type: 'text', text: EXTRACT_PROMPT }, promptInput];

        try {
          const result = await withRetry(() =>
            getOpenRouter().chat.completions.create({
              model: 'qwen/qwen3.5-plus-20260420',
              messages: [
                { role: 'system', content: EXTRACT_PROMPT },
                { role: 'user', content: typeof promptInput === 'string' ? promptInput : [promptInput] },
              ],
              response_format: { type: 'json_object' },
            })
          );
          const responseText = result.choices[0]?.message?.content || '[]';
          const jsonMatch = responseText.match(/\[[\s\S]*\]/);
          const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(responseText);

          return Array.isArray(parsed)
            ? parsed
                .map((item: any) => ({
                  source:      String(item.source ?? '').trim(),
                  source_type: VALID_ENTITY_TYPES.has(String(item.source_type ?? '').trim()) ? String(item.source_type).trim() : 'Entity',
                  relation:    String(item.relation ?? '').trim().toLowerCase(),
                  target:      String(item.target ?? '').trim(),
                  target_type: VALID_ENTITY_TYPES.has(String(item.target_type ?? '').trim()) ? String(item.target_type).trim() : 'Entity',
                }))
                .filter((item: any) =>
                  item.source.length >= 2 &&
                  item.target.length >= 2 &&
                  item.relation.length >= 2 &&
                  item.source !== item.target &&
                  !/^\d+$/.test(item.source) &&  // reject pure numbers
                  !/^\d+$/.test(item.target)
                )
            : [];
        } catch (err: any) {
          throw new Error(`Qwen extraction failed: ${err.message}`);
        }
      });

      console.log(`[ingest] Extracted ${extractedData.length} triples from ${filename}`);

      // 3. Save to Neo4j (no embeddings yet — keep the critical path fast)
      await setStep(documentId, 'saving');
      await step.run('save-to-neo4j', async () => {
        if (!extractedData.length) return { inserted: 0 };
        const session = driver.session();
        try {
          try {
            await session.run(
              "CREATE VECTOR INDEX entity_name_embeddings IF NOT EXISTS FOR (e:Entity) ON (e.embedding) OPTIONS {indexConfig: { `vector.dimensions`: 768, `vector.similarity_function`: 'cosine' }}"
            );
          } catch (idxErr: any) {
            console.warn('[ingest] Vector index creation skipped (may be unsupported):', idxErr?.message);
          }
          try {
            await session.run(
              'CREATE CONSTRAINT entity_user_unique IF NOT EXISTS FOR (e:Entity) REQUIRE (e.name, e.user_id) IS NODE KEY'
            );
          } catch (conErr: any) {
            console.warn('[ingest] Constraint creation skipped:', conErr?.message);
          }
          await session.executeWrite(async (tx) => {
            const queries = extractedData.map((item) =>
              tx.run(
                `MERGE (s:Entity {name: $source, user_id: $userId})
                 ON CREATE SET s.type = $sourceType, s.created_at = datetime()
                 ON MATCH SET s.type = coalesce(s.type, $sourceType)
                 MERGE (t:Entity {name: $target, user_id: $userId})
                 ON CREATE SET t.type = $targetType, t.created_at = datetime()
                 ON MATCH SET t.type = coalesce(t.type, $targetType)
                 MERGE (s)-[r:RELATION {type: $relation, user_id: $userId, source_file: $filename}]->(t)
                 ON CREATE SET r.weight = 1, r.created_at = datetime()
                 ON MATCH SET r.weight = r.weight + 1`,
                {
                  source: item.source, sourceType: item.source_type,
                  target: item.target, targetType: item.target_type,
                  relation: item.relation, userId, filename: filename || 'Unknown Source',
                }
              )
            );
            await Promise.all(queries);
          });
        } finally {
          await session.close();
        }
        return { inserted: extractedData.length };
      });

      // 4. Mark complete — graph is now visible to the user
      await step.run('update-status', async () => {
        const uniqueEntities = new Set(extractedData.flatMap((d: any) => [d.source, d.target]));
        await supabaseAdmin.from('documents').update({
          processing_step: null,
          status: 'Completed',
          entity_count: uniqueEntities.size,
          relation_count: extractedData.length,
        }).eq('id', documentId);
      });

      // 5. Embeddings — no embedding provider configured (OpenRouter has no /embeddings endpoint).
      //    Chat uses exact match + substring search which works without embeddings.
      //    Using fileData.ext (not a local `ext` variable) to avoid closure capture bug.
      await step.run('generate-embeddings', async () => {
        return { embedded: 0, status: 'skipped — no embedding provider configured' };
      });

      return { success: true, relationsExtracted: extractedData.length };

    } catch (err: any) {
      console.error(`[ingest] FAILED for ${documentId}:`, err?.message || err);
      try {
        await supabaseAdmin.from('documents').update({ status: 'Failed', processing_step: null }).eq('id', documentId);
      } catch { /* non-fatal */ }
      throw err;
    }
  }
);
