/**
 * Thin adapter over the real ingestion pipeline.
 *
 * ⚠️  KNOWN DEBT — read before changing anything here.
 * `classifyDocument`, `extractChunk`, `chunkText` and `normaliseEntityName` are
 * module-private in src/lib/inngest/functions.ts, so this eval cannot import
 * them.  Worse, functions.ts instantiates the Inngest client, the Supabase
 * service client and the Neo4j driver at module scope, so importing it from a
 * bare ts-node script would try to open those connections just to classify a
 * string.
 *
 * So the two LLM-calling functions below are a VERBATIM copy of the ones in
 * functions.ts (as of the commit that added this eval).  Everything that IS
 * exported — VALID_CLASSES, getTemplate, MODELS, withRetry — is imported for
 * real, so template/prompt/model changes are picked up automatically; only the
 * ~40 lines of prompt-assembly glue are duplicated.
 *
 * ponytail: copied prompt glue, drifts if functions.ts changes. Fix by
 * exporting `classifyDocument` / `extractChunk` / `chunkText` from
 * functions.ts (or moving them to a side-effect-free src/lib/inngest/extract.ts)
 * and deleting the bodies below in favour of a plain import.
 */
import OpenAI from 'openai';
import { VALID_CLASSES, getTemplate, type ExtractionTemplate } from '../src/lib/inngest/templates';
import { MODELS } from '../src/lib/config/models';
import { withRetry } from '../src/lib/utils/retry';

export { getTemplate, VALID_CLASSES };

export interface Entity { name: string; type: string }
export interface GraphTriple {
  source: string;
  source_type: string;
  relation: string;
  target: string;
  target_type: string;
}

/** Fail loudly and readably instead of with a 401 stack trace from the SDK. */
export function requireApiKey(): void {
  if (!process.env.OPENROUTER_API_KEY) {
    console.error(
      '\n  Missing OPENROUTER_API_KEY.\n' +
      '  This eval calls the real OpenRouter models — there is no offline/mock mode.\n' +
      '  Set it in web/.env.local (see .env.example) or export it in your shell, then re-run.\n',
    );
    process.exit(1);
  }
}

function getOpenRouter(): OpenAI {
  return new OpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: process.env.OPENROUTER_API_KEY || 'placeholder',
  });
}

// ── copied verbatim from functions.ts ────────────────────────────────────────
function normaliseEntityName(name: string): string {
  return name
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/['']/g, "'")
    .replace(/[""]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/[​-‍﻿]/g, '');
}

export function chunkText(text: string, size = 1_500, overlap = 200): string[] {
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
    return VALID_CLASSES.has(raw) ? raw : 'general';
  } catch {
    return 'general';
  }
}

export async function extractChunk(
  chunk: string,
  template: ExtractionTemplate,
  registry: Entity[],
): Promise<{ entities: Entity[]; triples: GraphTriple[] }> {
  const regSlice = registry.slice(-200);
  const registryLine = regSlice.length
    ? `\nKNOWN ENTITIES — always use these exact canonical names, never create an alias:\n${
        regSlice.map((e) => `${e.name} (${e.type})`).join(', ')
      }\n`
    : '';

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
        { role: 'user', content: chunk },
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

  const entities: Entity[] = (Array.isArray(parsed.entities) ? parsed.entities : [])
    .map((e: any) => ({
      name: normaliseEntityName(String(e?.name ?? '')),
      type: String(e?.type ?? 'Entity').trim() || 'Entity',
    }))
    .filter((e: Entity) => e.name.length >= 2 && !/^\d+$/.test(e.name));

  const entityTypeLookup = new Map<string, string>();
  for (const e of [...regSlice, ...entities]) entityTypeLookup.set(e.name.toLowerCase(), e.type);

  const triples: GraphTriple[] = (Array.isArray(parsed.relations) ? parsed.relations : [])
    .map((r: any) => ({
      source: normaliseEntityName(String(r?.source ?? '')),
      source_type: String(r?.source_type ?? '').trim() || entityTypeLookup.get(normaliseEntityName(String(r?.source ?? '')).toLowerCase()) || 'Entity',
      relation: normaliseEntityName(String(r?.relation ?? '')).toUpperCase().replace(/\s+/g, '_'),
      target: normaliseEntityName(String(r?.target ?? '')),
      target_type: String(r?.target_type ?? '').trim() || entityTypeLookup.get(normaliseEntityName(String(r?.target ?? '')).toLowerCase()) || 'Entity',
    }))
    .filter((t: GraphTriple) =>
      t.source.length >= 2 &&
      t.target.length >= 2 &&
      t.relation.length >= 2 &&
      t.source !== t.target &&
      !/^\d+$/.test(t.source) &&
      !/^\d+$/.test(t.target),
    );

  return { entities, triples };
}

/** Full document → { docClass, entities, triples }, same order of operations as the Inngest job. */
export async function runPipeline(text: string): Promise<{
  docClass: string;
  entities: Entity[];
  triples: GraphTriple[];
}> {
  const docClass = await classifyDocument(text);
  const template = getTemplate(docClass);
  const registry: Entity[] = [];
  const triples: GraphTriple[] = [];

  for (const chunk of chunkText(text.slice(0, 20_000))) {
    const out = await extractChunk(chunk, template, registry);
    for (const e of out.entities) {
      if (!registry.some((r) => r.name.toLowerCase() === e.name.toLowerCase())) registry.push(e);
    }
    triples.push(...out.triples);
  }
  return { docClass, entities: registry, triples };
}
