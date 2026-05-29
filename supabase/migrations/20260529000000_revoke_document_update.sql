-- Drop the permissive UPDATE policy on the documents table.
-- The client should not be able to arbitrarily modify their own document records,
-- especially the `storage_path` which could be spoofed to point to other users' files.
-- All document status updates will be handled by the backend / Inngest (which bypass RLS).
DROP POLICY IF EXISTS "Users can update their own documents" ON public.documents;
