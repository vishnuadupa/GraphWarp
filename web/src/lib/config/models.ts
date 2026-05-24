/**
 * OpenRouter model identifiers — change here when rotating models,
 * not in individual route files.
 */
export const MODELS = {
  /**
   * Vision-capable extraction model.
   * Handles text, images (base64 data URL), and structured prompts.
   * Used by the Inngest ingestion pipeline.
   */
  EXTRACTION: 'qwen/qwen3.5-plus-20260420',

  /**
   * Fast, cost-effective chat / RAG synthesis model.
   * Used for entity extraction from questions and answer generation.
   */
  CHAT: 'deepseek/deepseek-v4-flash',
} as const;
