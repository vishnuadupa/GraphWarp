/**
 * Neo4j driver singleton for Vercel serverless + AuraDB.
 *
 * Design decisions:
 * - One driver per process (module-level singleton). Vercel warm Lambdas
 *   reuse the same process, so this avoids reconnecting on every request.
 * - On cold starts the driver creates connections lazily (first session.run()).
 * - SIGTERM resets the singleton so a hypothetical warm reuse after shutdown
 *   doesn't hand callers a closed driver.
 * - Schema init runs once per process, fire-and-forget, non-fatal.
 */
import neo4j, { Driver } from 'neo4j-driver';

let instance: Driver | null = null;
let schemaInitialized = false;

function getDriver(): Driver {
  if (!instance) {
    const uri      = process.env.NEO4J_URI;
    const user     = process.env.NEO4J_USERNAME || process.env.NEO4J_USER;
    const password = process.env.NEO4J_PASSWORD;

    if (!uri || !user || !password) {
      throw new Error(
        'Missing Neo4j env vars: NEO4J_URI, NEO4J_USERNAME, and NEO4J_PASSWORD are required',
      );
    }

    instance = neo4j.driver(uri, neo4j.auth.basic(user, password), {
      // Small pool — AuraDB free tier caps concurrent connections; each
      // serverless Lambda instance gets its own pool so keep it lean.
      maxConnectionPoolSize: 5,
      // Cold-start TCP+TLS handshake to AuraDB can take up to 15 s.
      connectionAcquisitionTimeout: 30_000,
      // Retry managed transactions on transient errors.
      maxTransactionRetryTime: 15_000,
    });

    if (!schemaInitialized) {
      schemaInitialized = true;
      initSchema(instance).catch((err) =>
        console.warn('[neo4j] Schema init failed:', err?.message),
      );
    }
  }
  return instance;
}

/** Exported driver — use exactly like a real neo4j Driver. */
export const driver = {
  session: (options?: Parameters<Driver['session']>[0]) => getDriver().session(options),
  close:   ()                                           => getDriver().close(),
  verifyConnectivity: ()                                => getDriver().verifyConnectivity(),
} as unknown as Driver;

async function initSchema(d: Driver): Promise<void> {
  const session = d.session();
  try {
    try {
      await session.run(
        'CREATE CONSTRAINT entity_user_unique IF NOT EXISTS ' +
        'FOR (e:Entity) REQUIRE (e.name, e.user_id) IS NODE KEY',
      );
    } catch (err: any) {
      console.warn('[neo4j] Constraint init skipped:', err?.message);
    }
    try {
      await session.run(
        'CREATE VECTOR INDEX entity_name_embeddings IF NOT EXISTS ' +
        'FOR (e:Entity) ON (e.embedding) ' +
        "OPTIONS {indexConfig: { `vector.dimensions`: 768, `vector.similarity_function`: 'cosine' }}",
      );
    } catch (err: any) {
      console.warn('[neo4j] Vector index init skipped:', err?.message);
    }
  } finally {
    await session.close();
  }
}

// On SIGTERM reset the singleton so any hypothetical next invocation in the
// same process gets a fresh driver rather than a closed one.
process.on('SIGTERM', async () => {
  const d = instance;
  instance = null;
  schemaInitialized = false;
  if (d) await d.close().catch(() => {});
});
process.on('SIGINT', async () => {
  const d = instance;
  instance = null;
  schemaInitialized = false;
  if (d) await d.close().catch(() => {});
});
