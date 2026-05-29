/**
 * OpenRouter model identifiers — change here when rotating models,
 * not in individual route files.
 */
export const MODELS = {
  /**
   * Schema discovery — reads ~2 KB of a document and returns a mini-ontology
   * (entity types + relationship verbs) for the extraction stage.
   * Needs to be fast and cheap; a small model is fine here.
   */
  DISCOVERY: 'deepseek/deepseek-v4-flash',

  /**
   * Main extraction model — runs per chunk, anchored to the discovered schema
   * and the rolling entity registry.  A stronger model pays off here because
   * this is the highest-value reasoning step.
   */
  EXTRACTION: 'deepseek/deepseek-v4-flash',

  /**
   * Chat / RAG synthesis model — answer generation from graph context.
   */
  CHAT: 'deepseek/deepseek-v4-flash',
} as const;
