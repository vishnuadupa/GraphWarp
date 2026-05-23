import { driver } from '../src/lib/neo4j/neo4j';
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

async function main() {
  const session = driver.session();
  try {
    console.log("Creating Neo4j constraints...");
    await session.executeWrite(tx => 
      tx.run(`CREATE CONSTRAINT entity_user_unique IF NOT EXISTS FOR (e:Entity) REQUIRE (e.name, e.user_id) IS NODE KEY;`)
    );
    console.log("Successfully created Neo4j constraints.");
  } catch (err) {
    console.error("Failed to create constraints", err);
  } finally {
    await session.close();
    await driver.close();
  }
}

main();
