-- =============================================================================
-- DB Hardening: security, performance, and schema quality improvements
-- Addresses all issues flagged by Supabase security + performance advisors
-- =============================================================================

-- ── 1. Move vector extension out of public schema ─────────────────────────────
ALTER EXTENSION vector SET SCHEMA extensions;

-- ── 2. Missing FK indexes ─────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS documents_user_id_idx
  ON public.documents (user_id);

CREATE INDEX IF NOT EXISTS document_embeddings_document_id_idx
  ON public.document_embeddings (document_id);

CREATE INDEX IF NOT EXISTS document_embeddings_user_id_idx
  ON public.document_embeddings (user_id);

-- ── 3. Drop dead column (Gemini BYOK replaced by OpenRouter) ─────────────────
ALTER TABLE public.profiles
  DROP COLUMN IF EXISTS encrypted_gemini_api_key;

-- ── 4. Fix RLS initplan: wrap auth.uid() in (select ...) on all tables ────────
--    Plain auth.uid() re-evaluates per row; (select auth.uid()) evaluates once.

-- profiles
DROP POLICY IF EXISTS "Users can select own profile"  ON public.profiles;
DROP POLICY IF EXISTS "Users can insert own profile"  ON public.profiles;
DROP POLICY IF EXISTS "Users can update own profile"  ON public.profiles;
DROP POLICY IF EXISTS "Users can delete own profile"  ON public.profiles;

CREATE POLICY "Users can select own profile" ON public.profiles
  FOR SELECT TO authenticated USING ((select auth.uid()) = id);
CREATE POLICY "Users can insert own profile" ON public.profiles
  FOR INSERT TO authenticated WITH CHECK ((select auth.uid()) = id);
CREATE POLICY "Users can update own profile" ON public.profiles
  FOR UPDATE TO authenticated
  USING      ((select auth.uid()) = id)
  WITH CHECK ((select auth.uid()) = id);
CREATE POLICY "Users can delete own profile" ON public.profiles
  FOR DELETE TO authenticated USING ((select auth.uid()) = id);

-- documents
DROP POLICY IF EXISTS "Users can select their own documents" ON public.documents;
DROP POLICY IF EXISTS "Users can insert their own documents" ON public.documents;
DROP POLICY IF EXISTS "Users can update their own documents" ON public.documents;
DROP POLICY IF EXISTS "Users can delete their own documents" ON public.documents;

CREATE POLICY "Users can select their own documents" ON public.documents
  FOR SELECT TO authenticated USING ((select auth.uid()) = user_id);
CREATE POLICY "Users can insert their own documents" ON public.documents
  FOR INSERT TO authenticated WITH CHECK ((select auth.uid()) = user_id);
CREATE POLICY "Users can update their own documents" ON public.documents
  FOR UPDATE TO authenticated
  USING      ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);
CREATE POLICY "Users can delete their own documents" ON public.documents
  FOR DELETE TO authenticated USING ((select auth.uid()) = user_id);

-- document_embeddings
DROP POLICY IF EXISTS "Users can select their own embeddings" ON public.document_embeddings;
DROP POLICY IF EXISTS "Users can insert their own embeddings" ON public.document_embeddings;
DROP POLICY IF EXISTS "Users can update their own embeddings" ON public.document_embeddings;
DROP POLICY IF EXISTS "Users can delete their own embeddings" ON public.document_embeddings;

CREATE POLICY "Users can select their own embeddings" ON public.document_embeddings
  FOR SELECT TO authenticated USING ((select auth.uid()) = user_id);
CREATE POLICY "Users can insert their own embeddings" ON public.document_embeddings
  FOR INSERT TO authenticated WITH CHECK ((select auth.uid()) = user_id);
CREATE POLICY "Users can update their own embeddings" ON public.document_embeddings
  FOR UPDATE TO authenticated
  USING      ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);
CREATE POLICY "Users can delete their own embeddings" ON public.document_embeddings
  FOR DELETE TO authenticated USING ((select auth.uid()) = user_id);

-- conversations (drop stale ALL policy + recreate per-action)
DROP POLICY IF EXISTS "own_conversations"                        ON public.conversations;
DROP POLICY IF EXISTS "Users can select their own conversations" ON public.conversations;
DROP POLICY IF EXISTS "Users can insert their own conversations" ON public.conversations;
DROP POLICY IF EXISTS "Users can update their own conversations" ON public.conversations;
DROP POLICY IF EXISTS "Users can delete their own conversations" ON public.conversations;

CREATE POLICY "Users can select their own conversations" ON public.conversations
  FOR SELECT TO authenticated USING ((select auth.uid()) = user_id);
CREATE POLICY "Users can insert their own conversations" ON public.conversations
  FOR INSERT TO authenticated WITH CHECK ((select auth.uid()) = user_id);
CREATE POLICY "Users can update their own conversations" ON public.conversations
  FOR UPDATE TO authenticated
  USING      ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);
CREATE POLICY "Users can delete their own conversations" ON public.conversations
  FOR DELETE TO authenticated USING ((select auth.uid()) = user_id);

-- conversation_messages (drop stale ALL policy + recreate per-action)
DROP POLICY IF EXISTS "own_messages"                                          ON public.conversation_messages;
DROP POLICY IF EXISTS "Users can select messages from their own conversations" ON public.conversation_messages;
DROP POLICY IF EXISTS "Users can insert messages into their own conversations" ON public.conversation_messages;
DROP POLICY IF EXISTS "Users can update messages in their own conversations"   ON public.conversation_messages;
DROP POLICY IF EXISTS "Users can delete messages from their own conversations" ON public.conversation_messages;

CREATE POLICY "Users can select messages from their own conversations"
  ON public.conversation_messages FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.conversations
    WHERE conversations.id      = conversation_messages.conversation_id
      AND conversations.user_id = (select auth.uid())
  ));
CREATE POLICY "Users can insert messages into their own conversations"
  ON public.conversation_messages FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.conversations
    WHERE conversations.id      = conversation_messages.conversation_id
      AND conversations.user_id = (select auth.uid())
  ));
CREATE POLICY "Users can update messages in their own conversations"
  ON public.conversation_messages FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.conversations
    WHERE conversations.id      = conversation_messages.conversation_id
      AND conversations.user_id = (select auth.uid())
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.conversations
    WHERE conversations.id      = conversation_messages.conversation_id
      AND conversations.user_id = (select auth.uid())
  ));
CREATE POLICY "Users can delete messages from their own conversations"
  ON public.conversation_messages FOR DELETE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.conversations
    WHERE conversations.id      = conversation_messages.conversation_id
      AND conversations.user_id = (select auth.uid())
  ));

-- ── 5. Storage UPDATE policy (enables file upsert / replacement) ──────────────
CREATE POLICY "Users can update their own documents"
  ON storage.objects FOR UPDATE TO authenticated
  USING      (bucket_id = 'documents' AND auth.uid()::text = (storage.foldername(name))[1])
  WITH CHECK (bucket_id = 'documents' AND auth.uid()::text = (storage.foldername(name))[1]);

-- ── 6. documents.status CHECK constraint ─────────────────────────────────────
ALTER TABLE public.documents
  ADD CONSTRAINT documents_status_check
  CHECK (status IN ('Processing', 'Completed', 'Failed'));

-- ── 7. updated_at auto-trigger for profiles and conversations ─────────────────
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profiles_set_updated_at      ON public.profiles;
DROP TRIGGER IF EXISTS conversations_set_updated_at  ON public.conversations;

CREATE TRIGGER profiles_set_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER conversations_set_updated_at
  BEFORE UPDATE ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
