/**
 * Pluggable embedding client — works with any OpenAI-compatible embeddings API.
 *
 * Enable by setting environment variables:
 *   OPENAI_API_KEY         — API key (also accepts EMBEDDING_API_KEY as alias)
 *   EMBEDDING_API_BASE_URL — endpoint base URL (default: https://api.openai.com/v1)
 *   EMBEDDING_MODEL        — model name        (default: text-embedding-3-small)
 *   EMBEDDING_DIMENSIONS   — output dimensions (default: 768, must match Neo4j vector index)
 *
 * When no key is configured, all functions return null gracefully so the rest
 * of the pipeline continues without embeddings (exact + substring search still works).
 */

import OpenAI from 'openai';

const API_KEY    = process.env.OPENAI_API_KEY || process.env.EMBEDDING_API_KEY || null;
const BASE_URL   = process.env.EMBEDDING_API_BASE_URL || 'https://api.openai.com/v1';
const MODEL      = process.env.EMBEDDING_MODEL || 'text-embedding-3-small';
export const DIMENSIONS = parseInt(process.env.EMBEDDING_DIMENSIONS || '768', 10);

export const embeddingsEnabled = Boolean(API_KEY);

function getClient(): OpenAI {
  if (!API_KEY) throw new Error('No embedding API key configured (set OPENAI_API_KEY or EMBEDDING_API_KEY)');
  return new OpenAI({ apiKey: API_KEY, baseURL: BASE_URL });
}

/**
 * Embed a single text string.
 * Returns the vector or null if embeddings are not configured.
 */
export async function embedText(text: string): Promise<number[] | null> {
  if (!API_KEY) return null;
  try {
    const client = getClient();
    const res = await client.embeddings.create({ model: MODEL, input: text, dimensions: DIMENSIONS });
    return res.data[0]?.embedding ?? null;
  } catch (err: any) {
    console.warn('[embeddings] embedText failed:', err?.message);
    return null;
  }
}

/**
 * Embed multiple texts in a single batched call (split into chunks of 100).
 * Returns an array parallel to the input — null entries where embedding failed.
 */
export async function embedBatch(texts: string[]): Promise<(number[] | null)[]> {
  if (!API_KEY || texts.length === 0) return texts.map(() => null);

  const CHUNK = 100;
  const results: (number[] | null)[] = [];

  for (let i = 0; i < texts.length; i += CHUNK) {
    const chunk = texts.slice(i, i + CHUNK);
    try {
      const client = getClient();
      const res = await client.embeddings.create({ model: MODEL, input: chunk, dimensions: DIMENSIONS });
      // API returns items in order
      results.push(...res.data.map((d) => d.embedding as number[]));
    } catch (err: any) {
      console.warn('[embeddings] embedBatch chunk failed:', err?.message);
      results.push(...chunk.map(() => null));
    }
  }

  return results;
}
