import { inngest } from './client';
import { supabaseAdmin } from '../supabase/service';
import OpenAI from 'openai';
import { driver } from '../neo4j/neo4j';
import { withRetry } from '../utils/retry';
import { MODELS } from '../config/models';
import { embedBatch, embeddingsEnabled, DIMENSIONS } from '../embeddings';
import * as mammoth from 'mammoth';
import Papa from 'papaparse';
import * as XLSX from 'xlsx';

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

/**
 * XLSX / XLS → graph triples, no LLM.
 * Reads the first sheet, converts to CSV format, then delegates to parseCsvToGraph.
 */
function parseXlsxToGraph(buffer: Buffer): GraphTriple[] {
  try {
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) return [];
    const sheet = workbook.Sheets[sheetName];
    const csv = XLSX.utils.sheet_to_csv(sheet);
    return parseCsvToGraph(Buffer.from(csv, 'utf8'));
  } catch (err: any) {
    console.warn('[ingest] XLSX parse failed:', err?.message);
    return [];
  }
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

// Applied only for image inputs. Teaches the model to recognise the visual
// grammar of any diagram type rather than guessing one fixed structure.
const IMAGE_EXTRACT_ADDENDUM = `

This is an image. Before extracting, silently identify which type(s) of visual content it contains, then apply the matching strategy below. If multiple types appear, apply all relevant strategies.

HIERARCHICAL DIAGRAMS (family trees, org charts, taxonomies, class diagrams):
  - Every line or branch between two nodes is a relationship — extract it.
  - Vertical position encodes hierarchy: nodes higher up are ancestors/parents/superiors.
  - Horizontal bar connecting two nodes at the same level = peer relationship (e.g. spouses, co-founders).
  - Do NOT collapse the whole diagram into vague "member of" triples — capture each direct connection.

FLOWCHARTS / PROCESS DIAGRAMS / STATE MACHINES:
  - Arrows represent directed relationships: source "leads to" / "triggers" / "results in" target.
  - Diamond decision nodes: each output path is a separate "branches to" relationship.
  - Capture every arrow, including loops and conditional branches.

SCIENTIFIC DIAGRAMS (biology, chemistry, physics, engineering):
  - Labelled arrows: X "produces" Y, X "inhibits" Y, X "converts to" Y, X "interacts with" Y.
  - Part-whole: X "contains" Y, X "is part of" Y, X "surrounds" Y.
  - Chemical structures: atoms connected by bonds are "bonded to"; functional groups are "part of" the molecule.
  - Circuit diagrams: components are "connected to" / "powers" / "controls".
  - Physics diagrams: forces, fields, or vectors between objects are "acts on" / "exerts" / "opposes".

MATHEMATICAL CONTENT (equations, geometric figures, graphs/plots):
  - Named variables or expressions in equations: X "equals" expression, X "represents" quantity.
  - Geometric elements: A "adjacent to" B, A "inscribed in" B, A "perpendicular to" B.
  - Graph/plot axes and data series: series "measures" quantity, A "greater than" B at condition.
  - Proofs or derivations: step A "implies" step B.

DATA VISUALISATIONS (bar charts, pie charts, scatter plots, tables):
  - Each labelled category is an entity; its value or proportion is a "has value" or "accounts for" relationship.
  - Comparative relationships: A "exceeds" B, A "correlates with" B.
  - Time-series: entity at time T1 "precedes" same entity at T2.

MIND MAPS / CONCEPT MAPS:
  - Central node to each branch: "includes" / "is type of" / "related to".
  - Labelled edges: use the label text directly as the relation.

TEXT-HEAVY IMAGES (screenshots, slides, whiteboards, handwritten notes):
  - Extract relationships from the text exactly as you would from a plain-text document.
  - Bullet lists and numbered steps: treat each item as an entity; sequential items "followed by" the next.

PHOTOGRAPHS OR ABSTRACT IMAGES WITH NO IDENTIFIABLE RELATIONAL CONTENT:
  - Return an empty JSON array: []
  - Do not invent relationships that are not visible or inferable from the image.`;

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

        // ── Route by accepted file type ───────────────────────────────────────
        const SUPPORTED = new Set(['csv', 'xlsx', 'xls', 'docx', 'txt']);
        if (!SUPPORTED.has(ext)) {
          throw new Error(
            `Unsupported file type ".${ext}". Accepted formats: .docx, .txt, .csv, .xlsx, .xls`,
          );
        }

        // Structured files: deterministic parse, no LLM cost
        if (ext === 'csv') {
          console.log('[ingest] CSV — parsing directly (no LLM)');
          return parseCsvToGraph(rawBuffer);
        }
        if (ext === 'xlsx' || ext === 'xls') {
          console.log(`[ingest] Excel (${ext}) — parsing directly (no LLM)`);
          return parseXlsxToGraph(rawBuffer);
        }

        // Unstructured text files: extract text then run LLM
        let promptInput: string;
        if (ext === 'docx') {
          const result = await mammoth.extractRawText({ buffer: rawBuffer });
          promptInput = result.value;
          console.log(`[ingest] DOCX — extracted ${result.value.length} chars`);
        } else {
          // txt and any other accepted text format
          promptInput = rawBuffer.toString('utf8');
          console.log(`[ingest] Text (${ext}) — ${promptInput.length} chars`);
        }

        const extractionNote = '\n\nOutput ONLY a raw JSON array, no markdown, no code blocks.';

        const result = await withRetry(() =>
          getOpenRouter().chat.completions.create({
            model: MODELS.EXTRACTION,
            messages: [
              { role: 'system', content: EXTRACT_PROMPT + extractionNote },
              { role: 'user',   content: promptInput },
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
            source:      normaliseEntityName(String(item.source      ?? '')),
            source_type: VALID_ENTITY_TYPES.has(String(item.source_type ?? '').trim())
              ? String(item.source_type).trim()
              : 'Entity',
            relation:    normaliseEntityName(String(item.relation    ?? '')).toLowerCase(),
            target:      normaliseEntityName(String(item.target      ?? '')),
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
          await session.executeWrite(async (tx: any) => {
            await tx.run(
              `UNWIND $batch AS item
               OPTIONAL MATCH (existing_s:Entity {user_id: $userId})
               WHERE toLower(existing_s.name) = toLower(item.source)
               WITH item, collect(existing_s.name)[0] AS canonS
               MERGE (s:Entity {name: coalesce(canonS, item.source), user_id: $userId})
               ON CREATE SET s.type = item.sourceType, s.created_at = datetime()
               ON MATCH  SET s.type = CASE WHEN s.type = 'Entity' THEN item.sourceType ELSE s.type END
               WITH s, item
               OPTIONAL MATCH (existing_t:Entity {user_id: $userId})
               WHERE toLower(existing_t.name) = toLower(item.target)
               WITH s, item, collect(existing_t.name)[0] AS canonT
               MERGE (t:Entity {name: coalesce(canonT, item.target), user_id: $userId})
               ON CREATE SET t.type = item.targetType, t.created_at = datetime()
               ON MATCH  SET t.type = CASE WHEN t.type = 'Entity' THEN item.targetType ELSE t.type END
               WITH s, t, item
               MERGE (s)-[r:RELATION {type: item.relation, user_id: $userId}]->(t)
               ON CREATE SET r.weight = 1, r.created_at = datetime(), r.source_files = [$filename]
               ON MATCH  SET r.weight = r.weight + 1,
                            r.source_files = CASE WHEN $filename IN coalesce(r.source_files, [])
                                             THEN coalesce(r.source_files, [])
                                             ELSE coalesce(r.source_files, []) + [$filename] END`,
              {
                batch: extractedData.map((item: GraphTriple) => ({
                  source:     item.source,
                  sourceType: item.source_type,
                  target:     item.target,
                  targetType: item.target_type,
                  relation:   item.relation,
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
