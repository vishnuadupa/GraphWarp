import neo4j from 'neo4j-driver';

let instance: any = null;
let schemaInitialized = false;

function getInstance() {
  if (!instance) {
    const uri      = process.env.NEO4J_URI;
    const user     = process.env.NEO4J_USERNAME || process.env.NEO4J_USER;
    const password = process.env.NEO4J_PASSWORD;

    if (!uri || !user || !password) {
      throw new Error(
        'Missing Neo4j env vars: NEO4J_URI, NEO4J_USERNAME, and NEO4J_PASSWORD are required',
      );
    }

    instance = neo4j.driver(
      uri,
      neo4j.auth.basic(user, password),
      {
        // Keep a modest pool — AuraDB free tier limits concurrent connections
        maxConnectionPoolSize: 5,
        // Wait patiently for connections during Vercel cold starts
        connectionAcquisitionTimeout: 30_000,
        // Retry managed transactions for up to 15 s on transient errors
        maxTransactionRetryTime: 15_000,
      },
    );

    // Fire-and-forget — does not block module exports, non-fatal on failure
    if (!schemaInitialized) {
      schemaInitialized = true;
      initSchema().catch((err) =>
        console.warn('[neo4j] Schema init failed:', err?.message)
      );
    }
  }
  return instance;
}

export const driver = new Proxy({} as any, {
  get(target, prop, receiver) {
    if (
      prop === '$$typeof' ||
      prop === 'then' ||
      prop === 'toJSON' ||
      prop === 'prototype' ||
      prop === 'valueOf' ||
      typeof prop === 'symbol'
    ) {
      return undefined;
    }
    return Reflect.get(getInstance(), prop, receiver);
  }
});


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

// Graceful shutdown — close all pooled connections when the process exits
process.on('SIGTERM', () => {
  if (instance) {
    instance.close().catch(() => {});
  }
});
process.on('SIGINT', () => {
  if (instance) {
    instance.close().catch(() => {});
  }
});
