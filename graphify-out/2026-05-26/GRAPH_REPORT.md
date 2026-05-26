# Graph Report - d:\Graph\web  (2026-05-26)

## Corpus Check
- Corpus is ~28,547 words - fits in a single context window. You may not need a graph.

## Summary
- 230 nodes · 305 edges · 21 communities (13 shown, 8 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 3 edges (avg confidence: 0.88)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Database & Graph Routes|Database & Graph Routes]]
- [[_COMMUNITY_AI Orchestration & Ingestion Workers|AI Orchestration & Ingestion Workers]]
- [[_COMMUNITY_Client Authentication & Dashboard Layouts|Client Authentication & Dashboard Layouts]]
- [[_COMMUNITY_Build Dependencies & Task Scripts|Build Dependencies & Task Scripts]]
- [[_COMMUNITY_Interactive Chat & Force-Graph Visualization|Interactive Chat & Force-Graph Visualization]]
- [[_COMMUNITY_TypeScript Compiler Configurations|TypeScript Compiler Configurations]]
- [[_COMMUNITY_Package Dependencies & Library Manifests|Package Dependencies & Library Manifests]]
- [[_COMMUNITY_Upload Panel & Dropzone Components|Upload Panel & Dropzone Components]]
- [[_COMMUNITY_Core GraphRAG Engine & Schema Setup|Core GraphRAG Engine & Schema Setup]]
- [[_COMMUNITY_Landing Page Components & Layouts|Landing Page Components & Layouts]]
- [[_COMMUNITY_Edge Authentication Middleware|Edge Authentication Middleware]]
- [[_COMMUNITY_Premium UI Showcase Concepts|Premium UI Showcase Concepts]]
- [[_COMMUNITY_Next.js App Configurations|Next.js App Configurations]]
- [[_COMMUNITY_IDE Assistant System Rules|IDE Assistant System Rules]]
- [[_COMMUNITY_Linting & Standards Configurations|Linting & Standards Configurations]]
- [[_COMMUNITY_Base Supabase Helper Creators|Base Supabase Helper Creators]]
- [[_COMMUNITY_CSS Processing System|CSS Processing System]]
- [[_COMMUNITY_Core Project Readme|Core Project Readme]]

## God Nodes (most connected - your core abstractions)
1. `createClient()` - 17 edges
2. `compilerOptions` - 16 edges
3. `driver` - 15 edges
4. `createClient()` - 10 edges
5. `processDocument Inngest Handler` - 6 edges
6. `scripts` - 5 edges
7. `inngest` - 5 edges
8. `Chat API POST Handler` - 5 edges
9. `supabaseAdmin` - 4 edges
10. `ChatPage()` - 3 edges

## Surprising Connections (you probably didn't know these)
- `Chat API POST Handler` --calls--> `Supabase Client Creator`  [EXTRACTED]
  web/src/app/api/chat/route.ts → web/src/lib/supabase/supabase.ts
- `Chat API POST Handler` --conceptually_related_to--> `initSchema Function`  [INFERRED]
  web/src/app/api/chat/route.ts → web/src/lib/neo4j/neo4j.ts
- `Chat API POST Handler` --shares_data_with--> `processDocument Inngest Handler`  [INFERRED]
  web/src/app/api/chat/route.ts → web/src/lib/inngest/functions.ts
- `Upload API POST Handler` --shares_data_with--> `processDocument Inngest Handler`  [EXTRACTED]
  web/src/app/api/upload/route.ts → web/src/lib/inngest/functions.ts
- `processDocument Inngest Handler` --conceptually_related_to--> `initSchema Function`  [INFERRED]
  web/src/lib/inngest/functions.ts → web/src/lib/neo4j/neo4j.ts

## Hyperedges (group relationships)
- **GraphWarp Architecture** — page_home_component, route_chat_post, route_upload_post, functions_process_document, neo4j_driver_config [INFERRED 0.85]
- **Document Ingestion Flow** — route_upload_post, functions_process_document, functions_deterministic_parser [EXTRACTED 1.00]
- **Query Resolution Flow** — route_chat_post, route_rag_pipeline, neo4j_driver_config [EXTRACTED 1.00]

## Communities (21 total, 8 thin omitted)

### Community 0 - "Database & Graph Routes"
Cohesion: 0.10
Nodes (4): genAI, driver, genAI, createClient()

### Community 1 - "AI Orchestration & Ingestion Workers"
Cohesion: 0.10
Nodes (17): MODELS, DIMENSIONS, embedBatch(), embeddingsEnabled, embedText(), getClient(), inngest, GraphTriple (+9 more)

### Community 2 - "Client Authentication & Dashboard Layouts"
Cohesion: 0.11
Nodes (8): geistMono, geistSans, jetbrainsMono, metadata, GlobalDropzone(), Doc, PROCESSING_STEPS, createClient()

### Community 3 - "Build Dependencies & Task Scripts"
Cohesion: 0.09
Nodes (21): devDependencies, dotenv, eslint, eslint-config-next, tailwindcss, @tailwindcss/postcss, ts-node, @types/node (+13 more)

### Community 4 - "Interactive Chat & Force-Graph Visualization"
Cohesion: 0.13
Nodes (18): ChatPage(), Conversation, EMPTY_GRAPH, GraphStats, Message, NodeDetail, starterQuestions(), TYPE_DOT_COLOR() (+10 more)

### Community 5 - "TypeScript Compiler Configurations"
Cohesion: 0.10
Nodes (19): compilerOptions, allowJs, esModuleInterop, incremental, isolatedModules, jsx, lib, module (+11 more)

### Community 6 - "Package Dependencies & Library Manifests"
Cohesion: 0.11
Nodes (19): dependencies, framer-motion, @google/generative-ai, inngest, lucide-react, mammoth, neo4j-driver, next (+11 more)

### Community 7 - "Upload Panel & Dropzone Components"
Cohesion: 0.18
Nodes (5): ACCEPTED_TYPES, UploadDropzoneProps, PROCESSING_STEPS, UploadItem, UploadPhase

### Community 8 - "Core GraphRAG Engine & Schema Setup"
Cohesion: 0.33
Nodes (9): Deterministic CSV/Excel Parser, Entity Normalization, processDocument Inngest Handler, Neo4j Driver Setup, initSchema Function, Chat API POST Handler, 3-Phase RAG Ingestion & Traversal Pipeline, Upload API POST Handler (+1 more)

### Community 11 - "Premium UI Showcase Concepts"
Cohesion: 0.67
Nodes (3): FeatureCard Component, GraphWarp Premium Knowledge Engine Concept, Home Component

## Knowledge Gaps
- **92 isolated node(s):** `eslintConfig`, `nextConfig`, `name`, `version`, `private` (+87 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **8 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `createClient()` connect `Client Authentication & Dashboard Layouts` to `Interactive Chat & Force-Graph Visualization`, `Upload Panel & Dropzone Components`?**
  _High betweenness centrality (0.023) - this node is a cross-community bridge._
- **Why does `dependencies` connect `Package Dependencies & Library Manifests` to `Build Dependencies & Task Scripts`?**
  _High betweenness centrality (0.021) - this node is a cross-community bridge._
- **Why does `createClient()` connect `Database & Graph Routes` to `AI Orchestration & Ingestion Workers`?**
  _High betweenness centrality (0.018) - this node is a cross-community bridge._
- **What connects `eslintConfig`, `nextConfig`, `name` to the rest of the system?**
  _94 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Database & Graph Routes` be split into smaller, more focused modules?**
  _Cohesion score 0.09581646423751687 - nodes in this community are weakly interconnected._
- **Should `AI Orchestration & Ingestion Workers` be split into smaller, more focused modules?**
  _Cohesion score 0.09982174688057041 - nodes in this community are weakly interconnected._
- **Should `Client Authentication & Dashboard Layouts` be split into smaller, more focused modules?**
  _Cohesion score 0.10666666666666667 - nodes in this community are weakly interconnected._