import neo4j from 'neo4j-driver';

const uri      = process.env.NEO4J_URI;
const user     = process.env.NEO4J_USERNAME || process.env.NEO4J_USER;
const password = process.env.NEO4J_PASSWORD;

if (!uri || !user || !password) {
  throw new Error(
    'Missing Neo4j env vars: NEO4J_URI, NEO4J_USERNAME, and NEO4J_PASSWORD are required',
  );
}

export const driver = neo4j.driver(
  uri,
  neo4j.auth.basic(user, password),
  {
    // Keep a modest pool — AuraDB free tier limits concurrent connections
    maxConnectionPoolSize: 10,
    // Fail fast if the pool is exhausted rather than queuing indefinitely
    connectionAcquisitionTimeout: 5_000,
    // Retry managed transactions for up to 15 s on transient errors
    maxTransactionRetryTime: 15_000,
  },
);

/**
 * One-time schema initialisation — runs once per cold start.
 * Uses IF NOT EXISTS so it is fully idempotent.
 *
 * Kept here (not in the Inngest function) so:
 *   1. It runs once per process, not once per uploaded file.
 *   2. The ingestion step.run() stays focused on data work.
 *
 * The vector index is created even though embeddings are currently skipped,
 * so it is ready the moment an embedding provider is wired in.
 */
async function initSchema(): Promise<void> {
  const session = driver.session();
  try {
    // Node uniqueness constraint — also implicitly creates a lookup index
    try {
      await session.run(
        'CREATE CONSTRAINT entity_user_unique IF NOT EXISTS ' +
        'FOR (e:Entity) REQUIRE (e.name, e.user_id) IS NODE KEY',
      );
    } catch (err: any) {
      console.warn('[neo4j] Constraint init skipped:', err?.message);
    }

    // Vector index — ready for when an embedding provider is configured
    try {
      await session.run(
        'CREATE VECTOR INDEX entity_name_embeddings IF NOT EXISTS ' +
        'FOR (e:Entity) ON (e.embedding) ' +
        "OPTIONS {indexConfig: { `vector.dimensions`: 768, `vector.similarity_function`: 'cosine' }}",
      );
    } catch (err: any) {
      console.warn('[neo4j] Vector index init skipped (may be unsupported on this tier):', err?.message);
    }
  } finally {
    await session.close();
  }
}

// Fire-and-forget — does not block module exports, non-fatal on failure
initSchema().catch((err) =>
  console.warn('[neo4j] Schema init failed:', err?.message),
);

// Graceful shutdown — close all pooled connections when the process exits
process.on('SIGTERM', () => {
  driver.close().catch(() => {});
});
process.on('SIGINT', () => {
  driver.close().catch(() => {});
});
