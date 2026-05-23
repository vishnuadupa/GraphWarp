-- Add missing columns to the public.documents table for tracking processing state and metrics
ALTER TABLE public.documents
ADD COLUMN IF NOT EXISTS processing_step text,
ADD COLUMN IF NOT EXISTS entity_count integer DEFAULT 0,
ADD COLUMN IF NOT EXISTS relation_count integer DEFAULT 0;
