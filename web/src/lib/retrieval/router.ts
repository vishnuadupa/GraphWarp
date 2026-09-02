import type OpenAI from 'openai';
import { MODELS } from '@/lib/config/models';
import { withRetry } from '@/lib/utils/retry';
import { logLlmUsage } from '@/lib/observability/usage-log';

export type QueryRoute = 'single_hop' | 'multi_hop' | 'summarization';

const VALID_ROUTES = new Set<QueryRoute>(['single_hop', 'multi_hop', 'summarization']);

/**
 * One cheap LLM call, closed enum output, fallback on any failure.
 * Same shape as classifyDocument in lib/inngest/functions.ts.
 *
 * Injection-safety: the model can only emit one token from VALID_ROUTES;
 * anything else falls back to 'multi_hop' (today's full pipeline), so a bad
 * or hostile classification can never make retrieval worse than the baseline.
 */
export async function classifyQuery(
  client: OpenAI,
  question: string,
  userId: string,
): Promise<QueryRoute> {
  const started = Date.now();
  try {
    const res = await withRetry(() =>
      client.chat.completions.create({
        model: MODELS.DISCOVERY,
        messages: [
          {
            role: 'system',
            content:
              'Classify the user question into exactly one of these categories and output ONLY that word:\n' +
              'single_hop — answerable from one entity and its direct relationships\n' +
              'multi_hop — needs chaining across several entities or indirect connections\n' +
              'summarization — asks for a broad overview or summary of a whole topic/corpus',
          },
          { role: 'user', content: question.slice(0, 500) },
        ],
        max_tokens: 10,
      }),
    );
    logLlmUsage({ route: 'chat', model: MODELS.DISCOVERY, usage: res.usage, latencyMs: Date.now() - started, userId });
    const raw = (res.choices[0]?.message?.content ?? '').trim().toLowerCase().replace(/\W/g, '_') as QueryRoute;
    return VALID_ROUTES.has(raw) ? raw : 'multi_hop';
  } catch {
    return 'multi_hop';
  }
}
