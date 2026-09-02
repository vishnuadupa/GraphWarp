-- =============================================================================
-- Drop document_embeddings: dead schema. Entity embeddings actually live as a
-- property on Neo4j :Entity nodes (see lib/neo4j/neo4j.ts vector index
-- entity_name_embeddings) — nothing in the app reads or writes this pgvector
-- table, it's just unused storage + RLS overhead left over from an earlier
-- design that predates the Neo4j-based retrieval path.
-- =============================================================================

DROP TABLE IF EXISTS public.document_embeddings;
