/**
 * Thin adapter over the real ingestion pipeline — imports the actual
 * classification/extraction/chunking functions from functions.ts directly
 * (they're exported for exactly this purpose) instead of maintaining a
 * parallel copy that would drift from the production prompt.
 *
 * functions.ts's Inngest/Supabase/Neo4j clients are all constructed lazily
 * (Proxy-wrapped or built on first use), so importing the module doesn't
 * open any connections just to call a pure classification/extraction
 * function.
 */
import {
  classifyDocument,
  extractChunk,
  chunkText,
  type GraphTriple,
} from '../src/lib/inngest/functions';
import { VALID_CLASSES, getTemplate } from '../src/lib/inngest/templates';

export { getTemplate, VALID_CLASSES, classifyDocument, extractChunk, chunkText };
export type { GraphTriple };

export interface Entity { name: string; type: string }

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
    const out = await extractChunk(chunk.text, template, registry);
    for (const e of out.entities) {
      if (!registry.some((r) => r.name.toLowerCase() === e.name.toLowerCase())) registry.push(e);
    }
    triples.push(...out.triples);
  }
  return { docClass, entities: registry, triples };
}
