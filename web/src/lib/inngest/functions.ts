import { inngest } from './client';
import { supabaseAdmin } from '../supabase/service';
import OpenAI from 'openai';
import { NonRetriableError } from 'inngest';
import { driver } from '../neo4j/neo4j';
import { withRetry } from '../utils/retry';
import { VALID_CLASSES, getTemplate, type ExtractionTemplate } from './templates';
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
    // Throw a non-retriable error so the user gets a clear failure signal,
    // not a silent 'Completed' document with 0 entities.
    throw new NonRetriableError(
      `Could not parse Excel file: ${err?.message ?? 'unknown error'}. The file may be corrupt or in an unsupported format.`
    );
  }
}

/** Split text into overlapping chunks so context bleeds across boundaries.
 *
 * Size is intentionally conservative (1 500 chars ≈ 375 tokens of input).
 * Dense structured files (numbered lists, member directories, data tables)
 * can generate 10 000+ tokens of JSON output from a single 4 000-char chunk,
 * which silently truncates on models with ≤ 4 096 output tokens.
 * Smaller input chunks → manageable output → no silent parse failures.
 */
function chunkText(text: string, size = 1_500, overlap = 200): string[] {
  if (text.length <= size) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + size, text.length);
    chunks.push(text.slice(start, end));
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
async function classifyDocument(sample: string): Promise<string> {
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

/**
 * Phase 2+3 — EXTRACT (per chunk).
 *
 * The system prompt is built entirely from our static template (selected by
 * classifyDocument). The document chunk is ONLY in the user message.
 * Template content is never influenced by the document.
 */
async function extractChunk(
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

  const res = await withRetry(() =>
    getOpenRouter().chat.completions.create({
      model: MODELS.EXTRACTION,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: chunk },
      ],
    }),
  );

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
        const SUPPORTED = new Set(['csv', 'xlsx', 'xls', 'docx', 'txt', 'pdf']);
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

        // Unstructured text files: 3-stage LLM pipeline
        let rawText: string;
        if (ext === 'docx') {
          const extracted = await mammoth.extractRawText({ buffer: rawBuffer });
          rawText = extracted.value;
          console.log(`[ingest] DOCX — extracted ${rawText.length} chars`);
        } else if (ext === 'pdf') {
          // Dynamic import avoids build-time crashes (pdf-parse uses fs at module level)
          let pdfData: any;
          try {
            const pdfMod = await import('pdf-parse');
            const pdfParse = (pdfMod as any).default ?? pdfMod;
            pdfData = await pdfParse(rawBuffer);
          } catch (pdfErr: any) {
            throw new NonRetriableError(
              `Could not parse PDF: ${pdfErr?.message ?? 'unknown error'}. ` +
              'The file may be corrupt, password-protected, or in an unsupported format.',
            );
          }
          rawText = pdfData.text ?? '';
          console.log(`[ingest] PDF — ${pdfData.numpages} pages, ${rawText.length} chars`);
          // Scanned / image-only PDFs produce near-zero text — fail fast, don't retry
          if (rawText.trim().length < 100) {
            throw new NonRetriableError(
              `This PDF appears to be scanned or image-only (only ${rawText.trim().length} characters extracted). ` +
              'Please upload a text-based PDF exported from a document editor.',
            );
          }
        } else {
          rawText = rawBuffer.toString('utf8');
          console.log(`[ingest] Text (${ext}) — ${rawText.length} chars`);
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

        for (let i = 0; i < chunks.length; i++) {
          try {
            const { entities, triples } = await extractChunk(chunks[i], template, entityRegistry);

            // Merge new entities into registry (case-insensitive dedup)
            for (const entity of entities) {
              if (entity.name.length >= 2 && !entityRegistry.some(
                (e) => e.name.toLowerCase() === entity.name.toLowerCase(),
              )) {
                entityRegistry.push(entity);
              }
            }

            allTriples.push(...triples);
            console.log(`[ingest] Chunk ${i + 1}/${chunks.length} → ${entities.length} entities, ${triples.length} relations`);
          } catch (err: any) {
            console.warn(`[ingest] Chunk ${i + 1} failed, skipping: ${err?.message}`);
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
