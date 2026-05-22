# Database State

## Migrations
- `00001_init_schema.sql`: Initial schema containing `profiles` (for encrypted API key), `documents` (file tracking and storage reference), and `document_embeddings` (pgvector). All tables include strict Row-Level Security ensuring `auth.uid()` filtering.

## Tables
- `profiles`:
  - `id` (uuid, primary key, references auth.users(id))
  - `encrypted_gemini_api_key` (text, for BYOK API key)
  - `created_at` (timestamptz)
  - `updated_at` (timestamptz)
- `documents`:
  - `id` (uuid, primary key)
  - `user_id` (uuid, references auth.users(id))
  - `filename` (text)
  - `storage_path` (text, for Supabase Storage)
  - `status` (text)
  - `created_at` (timestamptz)
- `document_embeddings`:
  - `id` (uuid, primary key)
  - `document_id` (uuid, references documents(id))
  - `user_id` (uuid, references auth.users(id))
  - `content` (text)
  - `embedding` (vector(768))
  - `created_at` (timestamptz)

## Extensions
- `pgcrypto`: Used for encrypting sensitive data like the Gemini API key.
- `vector`: Used for pgvector embeddings (`document_embeddings`).
- `uuid-ossp`: Used for UUID generation.

## Security
- Row-Level Security (RLS) is enabled on all tables (`profiles`, `documents`, `document_embeddings`).
- Strict policies enforce `auth.uid() = id` (for profiles) and `auth.uid() = user_id` (for documents and embeddings) across SELECT, INSERT, UPDATE, and DELETE operations.
