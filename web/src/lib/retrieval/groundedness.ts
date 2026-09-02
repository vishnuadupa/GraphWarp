import type OpenAI from 'openai';
import { MODELS } from '@/lib/config/models';
import { withRetry } from '@/lib/utils/retry';
import { logLlmUsage } from '@/lib/observability/usage-log';

/**
 * Post-generation groundedness check. Runs AFTER the answer has streamed, so it
 * never blocks or re-generates — it only produces a trust indicator for the UI.
 * Returns null on any failure (fail open: the caller just skips the SSE event).
 */
export async function checkGroundedness(
  client: OpenAI,
  answer: string,
  context: string,
  userId: string,
): Promise<{ grounded: boolean; notes?: string } | null> {
  const started = Date.now();
  try {
    const res = await withRetry(() =>
      client.chat.completions.create({
        model: MODELS.DISCOVERY,
        messages: [
          {
            role: 'system',
            content:
              'You verify whether an ANSWER is supported by a CONTEXT of knowledge-graph facts.\n' +
              'First line: output exactly one word — "grounded" if every factual claim in the answer is supported by the context, otherwise "ungrounded".\n' +
              'Optional second line: list the unsupported claims, under 200 characters. Nothing else.',
          },
          { role: 'user', content: `CONTEXT:\n${context.slice(0, 8000)}\n\nANSWER:\n${answer.slice(0, 4000)}` },
        ],
        max_tokens: 120,
      }),
    );
    logLlmUsage({ route: 'chat', model: MODELS.DISCOVERY, usage: res.usage, latencyMs: Date.now() - started, userId });

    const out = (res.choices[0]?.message?.content ?? '').trim();
    const [verdictLine, ...rest] = out.split('\n');
    const verdict = verdictLine.trim().toLowerCase().replace(/\W/g, '');
    if (verdict !== 'grounded' && verdict !== 'ungrounded') return null; // outside the enum — fail open
    const notes = rest.join(' ').trim().slice(0, 200);
    return { grounded: verdict === 'grounded', ...(notes ? { notes } : {}) };
  } catch {
    return null;
  }
}
