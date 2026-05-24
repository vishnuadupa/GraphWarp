import { inngest } from './client';
import { supabaseAdmin } from '../supabase/service';
import OpenAI from 'openai';
import { driver } from '../neo4j/neo4j';
import { withRetry } from '../utils/retry';
import { MODELS } from '../config/models';
import * as mammoth from 'mammoth';
import Papa from 'papaparse';

// Lazy OpenRouter client — instantiated per call so a missing env var
// doesn't crash the module at import time (build-time safety).
function getOpenRouter(): OpenAI {
  return new OpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: process.env.OPENROUTER_API_KEY || 'placeholder',
  });
}

// ── Relationship column keyword map ───────────────────────────────────────────
// Keys are lowercase substrings matched against CSV/JSON column headers.
const REL_COLUMN_MAP: Record<string, { relation: string; sourceType: string; targetType: string }> = {
  father:       { relation: 'child of',      sourceType: 'Person',       targetType: 'Person' },
  mother:       { relation: 'child of',      sourceType: 'Person',       targetType: 'Person' },
  parent:       { relation: 'child of',      sourceType: 'Person',       targetType: 'Person' },
  spouse:       { relation: 'married to',    sourceType: 'Person',       targetType: 'Person' },
  husband:      { relation: 'married to',    sourceType: 'Person',       targetType: 'Person' },
  wife:         { relation: 'married to',    sourceType: 'Person',       targetType: 'Person' },
  partner:      { relation: 'partner of',    sourceType: 'Person',       targetType: 'Person' },
  child:        { relation: 'parent of',     sourceType: 'Person',       targetType: 'Person' },
  children:     { relation: 'parent of',     sourceType: 'Person',       targetType: 'Person' },
  son:          { relation: 'parent of',     sourceType: 'Person',       targetType: 'Person' },
  daughter:     { relation: 'parent of',     sourceType: 'Person',       targetType: 'Person' },
  sibling:      { relation: 'sibling of',    sourceType: 'Person',       targetType: 'Person' },
  brother:      { relation: 'sibling of',    sourceType: 'Person',       targetType: 'Person' },
  sister:       { relation: 'sibling of',    sourceType: 'Person',       targetType: 'Person' },
  manager:      { relation: 'reports to',    sourceType: 'Person',       targetType: 'Person' },
  reports_to:   { relation: 'reports to',    sourceType: 'Person',       targetType: 'Person' },
  supervisor:   { relation: 'supervised by', sourceType: 'Person',       targetType: 'Person' },
  employer:     { relation: 'works at',      sourceType: 'Person',       targetType: 'Organization' },
  company:      { relation: 'works at',      sourceType: 'Person',       targetType: 'Organization' },
  organization: { relation: 'member of',     sourceType: 'Person',       targetType: 'Organization' },
  owns:         { relation: 'owns',          sourceType: 'Person',       targetType: 'Entity' },
  owned_by:     { relation: 'owned by',      sourceType: 'Entity',       targetType: 'Person' },
  founded_by:   { relation: 'founded by',    sourceType: 'Organization', targetType: 'Person' },
  located_in:   { relation: 'located in',    sourceType: 'Entity',       targetType: 'Location' },
  location:     { relation: 'located in',    sourceType: 'Entity',       targetType: 'Location' },
  city:         { relation: 'born in',       sourceType: 'Person',       targetType: 'Location' },
  country:      { relation: 'from',          sourceType: 'Person',       targetType: 'Location' },
};

const NAME_SYNONYMS = ['name', 'fullname', 'full_name', 'person', 'entity', 'title', 'label', 'person_name'];

interface GraphTriple {
  source:      string;
  source_type: string;
  relation:    string;
  target:      string;
  target_type: string;
}

/**
 * CSV → graph triples, no LLM.
 * Detects the entity column by name, then maps relationship columns via REL_COLUMN_MAP.
 * Handles multi-value cells separated by ; or |
 */
function parseCsvToGraph(buffer: Buffer): GraphTriple[] {
  const { data, meta } = Papa.parse<Record<string, string>>(buffer.toString('utf8'), {
    header: true, skipEmptyLines: true, dynamicTyping: false,
  });
  if (!data.length || !meta.fields?.length) return [];

  const headers = meta.fields;
  const nameCol =
    headers.find((h) => NAME_SYNONYMS.includes(h.toLowerCase().replace(/[^a-z_]/g, ''))) ??
    headers[0];

  const triples: GraphTriple[] = [];
  for (const row of data) {
    const source = String(row[nameCol] ?? '').trim();
    if (!source) continue;

    for (const header of headers) {
      if (header === nameCol) continue;
      const colKey = header.toLowerCase().replace(/[^a-z_]/g, '');
      const relDef = Object.entries(REL_COLUMN_MAP).find(([k]) => colKey.includes(k))?.[1];
      if (!relDef) continue;

      const rawVal = String(row[header] ?? '').trim();
      if (!rawVal) continue;

      for (const target of rawVal.split(/[;|]/).map((v) => v.trim()).filter(Boolean)) {
        if (target !== source) {
          triples.push({
            source,
            source_type: relDef.sourceType,
            relation:    relDef.relation,
            target,
            target_type: relDef.targetType,
          });
        }
      }
    }
  }
  return triples;
}

/**
 * JSON → graph triples, no LLM.
 * Unwraps common envelope keys (data/items/results/nodes) then treats each
 * object in the array as an entity, mapping keys via REL_COLUMN_MAP.
 */
function parseJsonToGraph(buffer: Buffer): GraphTriple[] {
  let parsed: unknown;
  try { parsed = JSON.parse(buffer.toString('utf8')); } catch { return []; }

  const arr: unknown[] = Array.isArray(parsed)
    ? parsed
    : (
        (parsed as Record<string, unknown>).data ??
        (parsed as Record<string, unknown>).items ??
        (parsed as Record<string, unknown>).results ??
        (parsed as Record<string, unknown>).nodes ??
        Object.values(parsed as object)[0]
      ) as unknown[];

  if (!Array.isArray(arr) || !arr.length) return [];

  const keys = Object.keys(arr[0] as object);
  const nameKey = keys.find((k) => NAME_SYNONYMS.includes(k.toLowerCase())) ?? keys[0];

  const triples: GraphTriple[] = [];
  for (const item of arr as Record<string, unknown>[]) {
    const source = String(item[nameKey] ?? '').trim();
    if (!source) continue;

    for (const key of keys) {
      if (key === nameKey) continue;
      const colKey = key.toLowerCase().replace(/[^a-z_]/g, '');
      const relDef = Object.entries(REL_COLUMN_MAP).find(([k]) => colKey.includes(k))?.[1];
      if (!relDef) continue;

      const val = item[key];
      const targets = Array.isArray(val)
        ? (val as unknown[]).map(String)
        : String(val ?? '').split(/[;|,]/).map((v) => v.trim()).filter(Boolean);

      for (const target of targets) {
        if (target && target !== source) {
          triples.push({
            source,
            source_type: relDef.sourceType,
            relation:    relDef.relation,
            target,
            target_type: relDef.targetType,
          });
        }
      }
    }
  }
  return triples;
}

const VALID_ENTITY_TYPES = new Set([
  'Person', 'Organization', 'Location', 'Event', 'Concept', 'Technology', 'Entity',
]);

const EXTRACT_PROMPT =
  `Analyze the following document and extract all key entities and their relationships.
Output a JSON array of objects. Each object MUST have exactly these string properties:
  - "source": entity name, 2–100 characters, no leading/trailing spaces, capitalized (e.g. "Alice Smith", "Apple Inc")
  - "source_type": MUST be one of exactly: Person, Organization, Location, Event, Concept, Technology, Entity
  - "relation": relationship phrase, 2–50 characters, lowercase (e.g. "works at", "founded", "located in", "parent of", "child of", "married to", "sibling of")
  - "target": entity name, same rules as source
  - "target_type": MUST be one of exactly: Person, Organization, Location, Event, Concept, Technology, Entity
Rules: source and target must be different. No empty strings, no pure numbers, no punctuation-only names.
Extract as many meaningful relationships as possible.`;

const IMAGE_EXTRACT_ADDENDUM =
  `\n\nThis is a visual diagram or image. Apply these rules carefully:
- Examine ALL connecting lines, arrows, and branches — each one represents a relationship to extract.
- For family trees and org charts: items positioned ABOVE are ancestors/parents of items BELOW them. A line between two people means they are related (use "parent of", "child of", "married to", or "sibling of" as appropriate from visual layout).
- For flowcharts: arrows indicate direction of flow or dependency.
- Extract EVERY pairwise connection visible in the diagram. Do NOT summarize groups with vague "member of" relationships — capture the actual structural relationships shown by the lines.
- If two people share a horizontal line (spouse bar) they are partners. Vertical lines from that bar lead to children.
Prioritize structural/hierarchical relationships over generic membership.`;

// ── Main Inngest function ──────────────────────────────────────────────────────
export const processDocument = inngest.createFunction(
  {
    id: 'process-document',
    retries: 2,
    triggers: [{ event: 'document.process' }],
    // Limit to 3 concurrent jobs per user so Neo4j and OpenRouter aren't
    // hammered when someone uploads many files at once.
    concurrency: { limit: 3, key: 'event.data.userId' },
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

        // Structured files: deterministic parse, no LLM cost
        if (ext === 'csv') {
          console.log('[ingest] CSV — parsing directly (no LLM)');
          return parseCsvToGraph(rawBuffer);
        }
        if (ext === 'json') {
          console.log('[ingest] JSON — parsing directly (no LLM)');
          return parseJsonToGraph(rawBuffer);
        }

        // Unstructured files: extract text / build vision input first
        let promptInput: string | { type: 'image_url'; image_url: { url: string } };

        if (['png', 'jpg', 'jpeg', 'webp'].includes(ext)) {
          const mimeType = `image/${ext === 'jpg' ? 'jpeg' : ext}`;
          promptInput = { type: 'image_url', image_url: { url: `data:${mimeType};base64,${fileData.buffer}` } };
          console.log(`[ingest] Image (${ext}) — sending to Qwen vision`);
        } else if (ext === 'pdf') {
          try {
            // pdf-parse ships CJS; the `default` key exists at runtime but
            // TypeScript's ESM types don't declare it — cast via any.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const pdfMod = await import('pdf-parse') as any;
            const pdfParse = pdfMod.default ?? pdfMod;
            const pdfData = await pdfParse(rawBuffer);
            promptInput = pdfData.text;
            console.log(`[ingest] PDF — extracted ${pdfData.text.length} chars`);
          } catch (pdfErr: any) {
            console.warn(`[ingest] pdf-parse failed (${pdfErr.message}), using raw text fallback`);
            promptInput = rawBuffer.toString('utf8');
          }
        } else if (ext === 'docx') {
          const result = await mammoth.extractRawText({ buffer: rawBuffer });
          promptInput = result.value;
          console.log(`[ingest] DOCX — extracted ${result.value.length} chars`);
        } else {
          promptInput = rawBuffer.toString('utf8');
          console.log(`[ingest] Text (${ext}) — ${promptInput.length} chars`);
        }

        // Qwen3.5 Plus via OpenRouter — handles text and vision.
        // Vision: instruction + image in the SAME user message (required for vision models).
        // No response_format — conflicts with JSON array output and breaks vision requests.
        const isImage = typeof promptInput !== 'string';
        const extractionNote = '\n\nOutput ONLY a raw JSON array, no markdown, no code blocks.';
        // For images, add explicit visual-hierarchy guidance so the model extracts
        // structural relationships (parent-child lines) rather than generic "member of" triples.
        const imageAddendum = isImage ? IMAGE_EXTRACT_ADDENDUM : '';

        const result = await withRetry(() =>
          getOpenRouter().chat.completions.create({
            model: MODELS.EXTRACTION,
            messages: isImage
              ? [{
                  role: 'user',
                  content: [
                    { type: 'text', text: EXTRACT_PROMPT + imageAddendum + extractionNote },
                    promptInput as { type: 'image_url'; image_url: { url: string } },
                  ],
                }]
              : [
                  { role: 'system', content: EXTRACT_PROMPT + extractionNote },
                  { role: 'user',   content: promptInput as string },
                ],
          }),
        );

        const responseText = result.choices[0]?.message?.content ?? '[]';
        // Strip markdown code blocks if the model wraps output anyway
        const cleaned = responseText.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
        const jsonMatch = cleaned.match(/\[[\s\S]*\]/);

        let parsed: unknown;
        try {
          parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(cleaned);
        } catch {
          throw new Error(`Qwen returned non-JSON response: ${cleaned.slice(0, 200)}`);
        }

        if (!Array.isArray(parsed)) return [];

        return (parsed as Record<string, unknown>[])
          .map((item) => ({
            source:      String(item.source      ?? '').trim(),
            source_type: VALID_ENTITY_TYPES.has(String(item.source_type ?? '').trim())
              ? String(item.source_type).trim()
              : 'Entity',
            relation:    String(item.relation    ?? '').trim().toLowerCase(),
            target:      String(item.target      ?? '').trim(),
            target_type: VALID_ENTITY_TYPES.has(String(item.target_type ?? '').trim())
              ? String(item.target_type).trim()
              : 'Entity',
          }))
          .filter((item) =>
            item.source.length   >= 2 &&
            item.target.length   >= 2 &&
            item.relation.length >= 2 &&
            item.source !== item.target &&
            !/^\d+$/.test(item.source) &&
            !/^\d+$/.test(item.target),
          ) as GraphTriple[];
      });

      console.log(`[ingest] Extracted ${extractedData.length} triples from "${filename}"`);

      // ── Step 3: Save to Neo4j ──────────────────────────────────────────────
      // Schema init (index + constraint) is handled once in neo4j.ts on cold
      // start — not repeated here on every file.
      await step.run('save-to-neo4j', async () => {
        await supabaseAdmin.from('documents').update({ processing_step: 'saving' }).eq('id', documentId);

        if (!extractedData.length) return { inserted: 0 };

        const session = driver.session();
        try {
          await session.executeWrite(async (tx) => {
            const queries = extractedData.map((item: GraphTriple) =>
              tx.run(
                `MERGE (s:Entity {name: $source, user_id: $userId})
                 ON CREATE SET s.type = $sourceType, s.created_at = datetime()
                 ON MATCH  SET s.type = CASE WHEN s.type = 'Entity' THEN $sourceType ELSE s.type END
                 MERGE (t:Entity {name: $target, user_id: $userId})
                 ON CREATE SET t.type = $targetType, t.created_at = datetime()
                 ON MATCH  SET t.type = CASE WHEN t.type = 'Entity' THEN $targetType ELSE t.type END
                 MERGE (s)-[r:RELATION {type: $relation, user_id: $userId}]->(t)
                 ON CREATE SET r.weight = 1, r.created_at = datetime(), r.source_files = [$filename]
                 ON MATCH  SET r.weight = r.weight + 1,
                              r.source_files = CASE WHEN $filename IN coalesce(r.source_files, [])
                                               THEN coalesce(r.source_files, [])
                                               ELSE coalesce(r.source_files, []) + [$filename] END`,
                {
                  source:     item.source,
                  sourceType: item.source_type,
                  target:     item.target,
                  targetType: item.target_type,
                  relation:   item.relation,
                  userId,
                  filename:   filename || 'Unknown Source',
                },
              ),
            );
            await Promise.all(queries);
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

      // ── Step 5: Embeddings (currently skipped) ────────────────────────────
      // OpenRouter has no /embeddings endpoint, so embeddings are skipped for now.
      // Chat falls back to exact-match + substring search which works without them.
      // The vector index is already created (in neo4j.ts init) so this step can
      // be enabled by adding an embedding provider and populating the step body.
      await step.run('generate-embeddings', async () => ({
        embedded: 0,
        status:   'skipped — no embedding provider configured',
      }));

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
