import neo4j from 'neo4j-driver';

let schemaInitialized = false;

export const driver = new Proxy({} as any, {
  get(target, prop, receiver) {
    if (prop === '$$typeof' || prop === 'then' || prop === 'toJSON' || prop === 'prototype' || prop === 'valueOf' || typeof prop === 'symbol') {
      return undefined;
    }

    if (prop === 'close') {
      return async () => {}; // No-op since we manage driver lifecycles per session
    }

    if (prop === 'session') {
      return (options?: any) => {
        const uri      = process.env.NEO4J_URI;
        const user     = process.env.NEO4J_USERNAME || process.env.NEO4J_USER;
        const password = process.env.NEO4J_PASSWORD;

        if (!uri || !user || !password) {
          throw new Error('Missing Neo4j env vars: NEO4J_URI, NEO4J_USERNAME, and NEO4J_PASSWORD are required');
        }

        // Create a dedicated driver instance for this session
        const freshDriver = neo4j.driver(uri, neo4j.auth.basic(user, password), {
          maxConnectionPoolSize: 10,
          connectionAcquisitionTimeout: 30_000,
          maxTransactionRetryTime: 15_000,
        });

        // Initialize schema once asynchronously using a separate temporary driver
        if (!schemaInitialized) {
          schemaInitialized = true;
          const initDriver = neo4j.driver(uri, neo4j.auth.basic(user, password), { maxConnectionPoolSize: 2 });
          const initSession = initDriver.session();
          Promise.resolve().then(async () => {
            try {
              await initSession.run('CREATE CONSTRAINT entity_user_unique IF NOT EXISTS FOR (e:Entity) REQUIRE (e.name, e.user_id) IS NODE KEY');
            } catch (err: any) {
              console.warn('[neo4j] Constraint init skipped:', err?.message);
            }
            try {
              await initSession.run("CREATE VECTOR INDEX entity_name_embeddings IF NOT EXISTS FOR (e:Entity) ON (e.embedding) OPTIONS {indexConfig: { `vector.dimensions`: 768, `vector.similarity_function`: 'cosine' }}");
            } catch (err: any) {
              console.warn('[neo4j] Vector index init skipped:', err?.message);
            }
          }).finally(async () => {
            await initSession.close();
            await initDriver.close();
          });
        }

        const session = freshDriver.session(options);
        const originalClose = session.close.bind(session);
        
        // Wrap close() to also shut down the underlying driver TCP connections
        session.close = async () => {
          try {
            await originalClose();
          } finally {
            await freshDriver.close();
          }
        };

        return session;
      };
    }
    
    return undefined;
  }
});
