-- Track partial-extraction failures so "Completed" doesn't silently hide
-- chunks that errored out during ingestion (some entities/relations missing).
ALTER TABLE public.documents
ADD COLUMN IF NOT EXISTS chunks_failed integer DEFAULT 0;
