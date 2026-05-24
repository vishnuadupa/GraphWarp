/**
 * OpenRouter model identifiers — change here when rotating models,
 * not in individual route files.
 */
export const MODELS = {
  /**
   * Fast, cost-effective extraction model.
   * Switched to DeepSeek for high-performance text-based relationship extraction.
   */
  EXTRACTION: 'deepseek/deepseek-v4-flash',

  /**
   * Fast, cost-effective chat / RAG synthesis model.
   * Used for entity extraction from questions and answer generation.
   */
  CHAT: 'deepseek/deepseek-v4-flash',
} as const;
