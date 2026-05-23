// @ts-nocheck
import { inngest } from './client';
import { supabaseAdmin } from '../supabase/service';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { driver } from '../neo4j/neo4j';
import * as mammoth from 'mammoth';
import Papa from 'papaparse';
import pdfParse from 'pdf-parse';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

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
    console.error(`[ingest] Batch embed failed, falling back to sequential:`, err?.message);
    const out = [];
    for (const e of entities) out.push(await embedEntity(model, e));
    return out;
  }
}

async function setStep(documentId: string, step: string | null) {
  await supabaseAdmin.from('documents').update({ processing_step: step }).eq('id', documentId);
}

// ── Gemini extraction prompt ───────────────────────────────────────────────────
const EXTRACT_PROMPT = `Analyze the following document and extract all key entities and their relationships.
Output a JSON array of objects. Each object MUST have exactly these string properties:
  - "source": the source entity name (concise, capitalized)
  - "source_type": one of [Person, Organization, Location, Event, Concept, Technology, Entity]
  - "relation": the relationship verb/phrase
  - "target": the target entity name (concise, capitalized)
  - "target_type": one of [Person, Organization, Location, Event, Concept, Technology, Entity]
Keep entity names concise and consistent. Extract as many meaningful relationships as possible.`;

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
          // Images only: send as inline data (Gemini vision)
          const mimeType = `image/${ext === 'jpg' ? 'jpeg' : ext}`;
          promptInput = { inlineData: { data: fileData.buffer, mimeType } };
          console.log(`[ingest] Image (${ext}) — sending to Gemini vision`);
        } else if (ext === 'pdf') {
          // PDF: extract text with pdf-parse, send text (much cheaper than base64)
          try {
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

        // Call Gemini
        const model = genAI.getGenerativeModel({
          model: 'gemini-2.5-flash-lite',
          generationConfig: { responseMimeType: 'application/json' },
        });

        try {
          const result = await withRetry(() => model.generateContent([EXTRACT_PROMPT, promptInput]));
          const responseText = result.response.text();
          const jsonMatch = responseText.match(/\[[\s\S]*\]/);
          const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(responseText);

          return Array.isArray(parsed)
            ? parsed
                .filter((item: any) => item.source && item.relation && item.target)
                .map((item: any) => ({
                  source:      String(item.source).trim(),
                  source_type: String(item.source_type || 'Entity').trim(),
                  relation:    String(item.relation).trim(),
                  target:      String(item.target).trim(),
                  target_type: String(item.target_type || 'Entity').trim(),
                }))
            : [];
        } catch (err: any) {
          throw new Error(`Gemini extraction failed: ${err.message}`);
        }
      });

      console.log(`[ingest] Extracted ${extractedData.length} triples from ${filename}`);

      // 3. Embeddings
      await setStep(documentId, 'embedding');
      const embeddingsData = await step.run('generate-embeddings', async () => {
        if (!extractedData.length) return {};
        const entityMap: Record<string, string> = {};
        for (const d of extractedData) {
          if (!entityMap[d.source]) entityMap[d.source] = d.source_type;
          if (!entityMap[d.target]) entityMap[d.target] = d.target_type;
        }

        const embedModel = genAI.getGenerativeModel({ model: 'text-embedding-004' });
        const uniqueEntities = Object.keys(entityMap);
        const BATCH = 30;
        const result: Record<string, number[]> = {};

        for (let i = 0; i < uniqueEntities.length; i += BATCH) {
          const batch = uniqueEntities.slice(i, i + BATCH);
          const vectors = await embedEntitiesBatch(embedModel, batch);
          batch.forEach((entity, idx) => { if (vectors[idx]) result[entity] = vectors[idx]!; });
          if (i + BATCH < uniqueEntities.length) await new Promise((r) => setTimeout(r, 1000));
        }
        return result;
      });

      // 3.5 pgvector
      await step.run('save-to-postgres-pgvector', async () => {
        if (!extractedData.length) return { inserted: 0 };
        const uniqueEntities = new Set(extractedData.flatMap((d: any) => [d.source, d.target]));
        const inserts = Array.from(uniqueEntities)
          .map((entity) => ({ document_id: documentId, user_id: userId, content: entity, embedding: embeddingsData[entity] || null }))
          .filter(item => item.embedding !== null);
        if (!inserts.length) return { inserted: 0 };
        const { error } = await supabaseAdmin.from('document_embeddings').insert(inserts);
        if (error) console.error(`[ingest] pgvector insert error:`, error.message);
        return { inserted: inserts.length };
      });

      // 4. Neo4j
      await setStep(documentId, 'saving');
      await step.run('save-to-neo4j', async () => {
        if (!extractedData.length) return { inserted: 0 };
        const session = driver.session();
        try {
          await session.run(
            "CREATE VECTOR INDEX entity_name_embeddings IF NOT EXISTS FOR (e:Entity) ON (e.embedding) OPTIONS {indexConfig: { `vector.dimensions`: 768, `vector.similarity_function`: 'cosine' }}"
          );
          await session.run(
            'CREATE CONSTRAINT entity_user_unique IF NOT EXISTS FOR (e:Entity) REQUIRE (e.name, e.user_id) IS NODE KEY'
          );
          await session.executeWrite(async (tx) => {
            const queries = extractedData.map((item) =>
              tx.run(
                `MERGE (s:Entity {name: $source, user_id: $userId})
                 ON CREATE SET s.type = $sourceType, s.embedding = $sourceEmbedding, s.created_at = datetime()
                 ON MATCH SET s.type = coalesce(s.type, $sourceType), s.embedding = coalesce(s.embedding, $sourceEmbedding)
                 MERGE (t:Entity {name: $target, user_id: $userId})
                 ON CREATE SET t.type = $targetType, t.embedding = $targetEmbedding, t.created_at = datetime()
                 ON MATCH SET t.type = coalesce(t.type, $targetType), t.embedding = coalesce(t.embedding, $targetEmbedding)
                 MERGE (s)-[r:RELATION {type: $relation, user_id: $userId, source_file: $filename}]->(t)
                 ON CREATE SET r.weight = 1, r.created_at = datetime()
                 ON MATCH SET r.weight = r.weight + 1`,
                {
                  source: item.source, sourceType: item.source_type,
                  target: item.target, targetType: item.target_type,
                  relation: item.relation, userId, filename: filename || 'Unknown Source',
                  sourceEmbedding: embeddingsData[item.source] ?? null,
                  targetEmbedding: embeddingsData[item.target] ?? null,
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

      // 5. Mark complete
      await step.run('update-status', async () => {
        const uniqueEntities = new Set(extractedData.flatMap((d: any) => [d.source, d.target]));
        await supabaseAdmin.from('documents').update({
          processing_step: null,
          status: 'Completed',
          entity_count: uniqueEntities.size,
          relation_count: extractedData.length,
        }).eq('id', documentId);
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
