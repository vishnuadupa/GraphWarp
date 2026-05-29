-- Enable pgvector if not already enabled (should be, but safe to include)
CREATE EXTENSION IF NOT EXISTS vector;

-- Create semantic_cache table
CREATE TABLE IF NOT EXISTS public.semantic_cache (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    question text NOT NULL,
    question_embedding vector(1536) NOT NULL, -- OpenAI text-embedding-3-small dimension
    answer text NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL
);

-- Index for vector similarity search using HNSW (fast cosine similarity)
CREATE INDEX IF NOT EXISTS semantic_cache_embedding_idx ON public.semantic_cache USING hnsw (question_embedding vector_cosine_ops);

-- RLS policies
ALTER TABLE public.semantic_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can insert their own semantic cache."
    ON public.semantic_cache
    FOR INSERT
    TO authenticated
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can read their own semantic cache."
    ON public.semantic_cache
    FOR SELECT
    TO authenticated
    USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own semantic cache."
    ON public.semantic_cache
    FOR DELETE
    TO authenticated
    USING (auth.uid() = user_id);
