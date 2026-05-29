const neo4j = require('neo4j-driver');
require('dotenv').config({ path: '.env.local' });

async function test() {
  const uri = process.env.NEO4J_URI;
  const user = process.env.NEO4J_USERNAME || process.env.NEO4J_USER;
  const password = process.env.NEO4J_PASSWORD;

  const driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
  const session = driver.session();
  
  const triples = [{
    source: "Alice",
    sourceType: "Person",
    target: "Bob",
    targetType: "Person",
    relation: "friend",
    filename: "test.txt"
  }];
  const userId = "test-user-123";

  try {
    console.log("Running query...");
    const result = await session.executeWrite(tx =>
      tx.run(`
               UNWIND $triples AS triple
               OPTIONAL MATCH (existing_s:Entity {user_id: $userId})
               WHERE toLower(existing_s.name) = toLower(triple.source)
               WITH triple, collect(existing_s.name)[0] AS canonS
               MERGE (s:Entity {name: coalesce(canonS, triple.source), user_id: $userId})
               ON CREATE SET s.type = triple.sourceType, s.created_at = datetime()
               ON MATCH  SET s.type = CASE WHEN s.type = 'Entity' THEN triple.sourceType ELSE s.type END
               WITH triple, s
               OPTIONAL MATCH (existing_t:Entity {user_id: $userId})
               WHERE toLower(existing_t.name) = toLower(triple.target)
               WITH triple, s, collect(existing_t.name)[0] AS canonT
               MERGE (t:Entity {name: coalesce(canonT, triple.target), user_id: $userId})
               ON CREATE SET t.type = triple.targetType, t.created_at = datetime()
               ON MATCH  SET t.type = CASE WHEN t.type = 'Entity' THEN triple.targetType ELSE t.type END
               WITH s, t, triple
               MERGE (s)-[r:RELATION {type: triple.relation, user_id: $userId}]->(t)
               ON CREATE SET r.weight = 1, r.created_at = datetime(), r.source_files = [triple.filename]
               ON MATCH  SET r.weight = r.weight + 1,
                             r.source_files = CASE WHEN triple.filename IN coalesce(r.source_files, [])
                                              THEN coalesce(r.source_files, [])
                                              ELSE coalesce(r.source_files, []) + [triple.filename] END
      `, { triples, userId })
    );
    console.log("Success!", result.summary.counters);
  } catch (err) {
    console.error("Neo4j Error:", err);
  } finally {
    await session.close();
    await driver.close();
  }
}

test();
