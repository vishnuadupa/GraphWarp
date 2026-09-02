/**
 * Structured logging for LLM cost + latency. One JSON line per event,
 * plain console.log — no logging library, these are scraped from stdout.
 */

/** Shape of the OpenAI-compatible `.usage` field (present on non-streaming
 *  completions, and on the final chunk when `stream_options.include_usage`). */
type Usage = { prompt_tokens?: number; completion_tokens?: number } | null | undefined;

export function logLlmUsage(opts: {
  route: string;
  model: string;
  usage: Usage;
  latencyMs: number;
  userId: string;
}) {
  console.log(JSON.stringify({
    type: 'llm_usage',
    route: opts.route,
    model: opts.model,
    promptTokens: opts.usage?.prompt_tokens ?? null,
    completionTokens: opts.usage?.completion_tokens ?? null,
    latencyMs: opts.latencyMs,
    userId: opts.userId,
  }));
}

export function logRequestLatency(route: string, totalMs: number, userId: string) {
  console.log(JSON.stringify({ type: 'request_latency', route, totalMs, userId }));
}
