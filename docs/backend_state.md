# Backend State

## Ingestion API
- `src/app/api/upload/route.ts`: Endpoint hit by the frontend. Expects `{ fileUrl, filename }` in the POST body.
  - Verifies the user session via Supabase SSR (`src/lib/supabase/server.ts`).
  - Inserts a `document` row into Supabase with `status: 'Processing'`.
  - Triggers an Inngest event: `document.process`.
  - Returns 200 OK instantly.

## Inngest Background Workers
- `src/lib/inngest/functions.ts`: Contains the `processDocument` worker that listens to `document.process`.
  - Downloads the file from Supabase Storage using the service client (`src/lib/supabase/service.ts`).
  - Extracts and chunks the text (default chunk size: 3000 chars).
  - Calls the Gemini API (`@google/generative-ai` gemini-1.5-flash) with a structured prompt for Entity and Relationship extraction as JSON `{source, relation, target}`. Includes a ~4.1-second delay between chunks to respect Gemini's 15 RPM free-tier limit.
  - Connects to Neo4j and uses Cypher to `MERGE` the Nodes (`Entity`) and Edges (`RELATION`). Every Node and Edge includes the `user_id` property for multi-tenancy.
  - Updates the document status to `Completed` in Supabase upon success.

## Utilities
- `src/lib/supabase/server.ts`: Creates a Supabase server client using `@supabase/ssr` (Next.js cookies approach).
- `src/lib/supabase/service.ts`: Creates a Supabase admin client for server-side tasks (e.g. background worker operations) using `SUPABASE_SERVICE_ROLE_KEY`.
- `src/lib/neo4j/neo4j.ts`: Configures `neo4j-driver` using environment variables for AuraDB.
- `src/lib/inngest/client.ts`: Configures the Inngest client.

## Chat API
- `src/app/api/chat/route.ts`: Endpoint hit by the frontend. Expects `{ question }` in the POST body.
  - Verifies the user session via Supabase SSR (`src/lib/supabase/server.ts`).
  - Calls Gemini 1.5 Flash to extract key entities from the user's question as a JSON array of strings.
  - Queries Neo4j using `neo4j-driver` to fetch nodes (`n:Entity`) and relationships (`r:RELATION`) connected to the extracted entities. Enforces multi-tenancy by filtering with `WHERE n.user_id = $userId`.
  - Formats the retrieved subgraph paths (nodes and links) into a contextual string for the synthesis prompt.
  - Feeds the extracted subgraph context and the original question to Gemini 1.5 Pro to synthesize a definitive, factual answer.
  - Returns `{ answer, graph: { nodes, links } }` where nodes and links are formatted appropriately for visualization via `react-force-graph-2d`.
