# Atlas Ingestion Service — Architecture Overview

**Owner:** Elena Sorokina
**Status:** current as of v2.3.0

## Components

The Ingestion Service is a background worker built on Inngest. It exposes a single HTTP endpoint,
`POST /api/ingest`, which accepts an upload reference and emits a `document.process` event.

The worker depends on three external systems:

- **Supabase Storage** — holds the raw uploaded file. The worker downloads it over HTTPS.
- **Neo4j** — stores extracted entities and relationships. The worker connects over the Bolt
  protocol using the official neo4j-driver library.
- **OpenRouter** — hosts the classification and extraction models. Calls go over HTTPS.

## Pipeline

`DocumentClassifier` reads the first 500 characters and returns one label from a closed
enumeration. `ChunkExtractor` then splits the text and calls the extraction model per chunk,
returning entities and relations as JSON.

`ChunkExtractor` throws `ExtractionParseError` when the model returns malformed JSON; the caller
logs and skips that chunk rather than failing the whole document.

## Deprecations

The legacy `SchemaDiscovery` component is deprecated by `DocumentClassifier` and will be removed
in v3.0.0. The `MAX_CHUNK_CHARS` configuration key controls chunk size and is currently 1500.

## Deployment

The service is deployed on Vercel. Embedding generation is optional and is configured by the
`OPENAI_API_KEY` environment variable.
