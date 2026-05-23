import neo4j from 'neo4j-driver';

const uri      = process.env.NEO4J_URI;
const user     = process.env.NEO4J_USERNAME || process.env.NEO4J_USER;
const password = process.env.NEO4J_PASSWORD;

if (!uri || !user || !password) {
  throw new Error('Missing Neo4j env vars: NEO4J_URI, NEO4J_USERNAME, and NEO4J_PASSWORD are required');
}

export const driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
