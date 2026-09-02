-- =============================================================================
-- Fix semantic_cache: was declared vector(1536) (OpenAI native dim) but the
-- app embeds at 768 dims (EMBEDDING_DIMENSIONS, matches the Neo4j vector
-- index). Every insert has been silently failing since the table was
-- created — recreate at the correct dimension and add the similarity-search
-- RPC the chat route was already trying to call (match_semantic_cache),
-- which didn't exist, so lookups were silently falling back to exact-text
-- ILIKE matching instead of real semantic search.
-- =============================================================================

DROP TABLE IF EXISTS public.semantic_cache;

CREATE TABLE public.semantic_cache (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    question text NOT NULL,
    question_embedding vector(768) NOT NULL,
    answer text NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX semantic_cache_embedding_idx ON public.semantic_cache
  USING hnsw (question_embedding vector_cosine_ops);

CREATE INDEX semantic_cache_user_id_idx ON public.semantic_cache (user_id);

ALTER TABLE public.semantic_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can insert their own semantic cache"
    ON public.semantic_cache FOR INSERT TO authenticated
    WITH CHECK ((select auth.uid()) = user_id);

CREATE POLICY "Users can read their own semantic cache"
    ON public.semantic_cache FOR SELECT TO authenticated
    USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can delete their own semantic cache"
    ON public.semantic_cache FOR DELETE TO authenticated
    USING ((select auth.uid()) = user_id);

-- Cosine-similarity nearest-neighbour lookup, scoped to the caller's own rows.
-- search_path includes extensions (where pgvector's <=> operator lives after
-- the DB-hardening migration moved it out of public) and public, never a
-- caller-writable schema — SECURITY INVOKER + RLS still gates the actual rows.
CREATE OR REPLACE FUNCTION public.match_semantic_cache(
    query_embedding vector(768),
    match_threshold float,
    match_count int,
    user_id_param uuid
)
RETURNS TABLE (id uuid, answer text, similarity float)
LANGUAGE sql
STABLE
SET search_path = 'extensions', 'public'
AS $$
    SELECT
        sc.id,
        sc.answer,
        1 - (sc.question_embedding <=> query_embedding) AS similarity
    FROM public.semantic_cache sc
    WHERE sc.user_id = user_id_param
      AND 1 - (sc.question_embedding <=> query_embedding) >= match_threshold
    ORDER BY sc.question_embedding <=> query_embedding
    LIMIT match_count;
$$;

GRANT EXECUTE ON FUNCTION public.match_semantic_cache(vector, float, int, uuid) TO authenticated;
