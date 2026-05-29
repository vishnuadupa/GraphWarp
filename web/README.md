# GraphWarp

GraphWarp is an advanced document processing and interactive Knowledge Graph RAG (Retrieval-Augmented Generation) application built with Next.js, Neo4j, and Supabase.

## Features

- **Document Processing**: Upload TXT, Markdown, CSV, and **PDF** files (via dynamic `pdf-parse` integration).
- **3-Stage Domain-Adaptive Extraction Pipeline**:
  - **Stage 1 (discoverSchema)**: A fast LLM call on the first 2 KB infers a mini-ontology (entity types and UPPER_CASE relationship verbs) suited to the document domain (family tree, tech doc, medical paper, etc.).
  - **Stage 2 & 3 (extractChunk)**: Splits the document into 4000-character overlapping chunks and extracts entities/relations anchored to the discovered schema and a rolling entity registry to resolve coreferences (e.g., "Armstrong" -> "Neil Armstrong").
  - **resolveAliases**: A pre-write pass collapses any remaining aliases before writing to Neo4j.
- **Neo4j Singleton Driver**: Uses a robust module-level singleton driver pattern with connection pooling (`maxConnectionPoolSize: 5`) and a 30s acquisition timeout, preventing connection exhaustion on AuraDB's free tier.
- **Interactive Knowledge Graph**: Visualize your data using ForceGraph2D, with dynamic node sizing driven by JS-based PageRank.
- **Semantic Caching & Rate Limiting**: Uses `pgvector` for semantic caching of chat queries to minimize LLM costs, alongside Upstash sliding-window rate limiting.
- **Premium UI/UX**: Dark mode, glassmorphism, responsive panels, and smooth ESC-key UX to manage sidebars.

## Getting Started

1. **Install Dependencies**: `npm install`
2. **Setup Environment Variables**: Configure `.env.local` with your Supabase, Neo4j, OpenRouter, and Upstash keys.
3. **Run Dev Server**: `npm run dev`

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

## Tech Stack
- Next.js 16 (App Router)
- Supabase (Auth, Postgres, pgvector)
- Neo4j (AuraDB Free Tier)
- Inngest (Background Jobs)
- Playwright (E2E Testing)
- Tailwind CSS & next-themes
