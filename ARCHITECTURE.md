# Architecture Design Document: Multi-Tenant GraphRAG Knowledge Engine

## 1. Executive Summary & End Goal
**The Goal:** Build a full-stack, zero-budget, multi-tenant AI application that allows users to upload documents (up to 2MB) and chat with their data.
**The Solution:** Instead of a standard Vector RAG system, this project utilizes a **GraphRAG approach**. It extracts entities and relationships from the user's uploaded files to build a structural knowledge graph. When the user asks a question, the system traverses this graph to provide highly accurate, contextual answers, drastically reducing the hallucination rates common in traditional RAG setups.
**The Persona:** This project demonstrates the skills of a "Forward Deployed Engineer"—showcasing frontend UI, backend asynchronous pipelines, database architecture, AI orchestration, and cost-management.

---

## 2. Core Problem: Why GraphRAG over Standard RAG?
Standard RAG systems chunk text and use semantic similarity to find answers. This works well for simple questions but fails at multi-hop reasoning (e.g., "Who was managing the project when the server migration failed?").
GraphRAG solves this by:
1. Mapping explicit relationships (Nodes = Entities, Edges = Relationships).
2. Traversing the graph to connect the dots across different documents.
**Result:** Near-zero hallucinations because the AI's answers are structurally grounded in explicit data relationships.

---

## 3. Tech Stack & $0 Budget Strategy
To keep this project entirely free while handling complex infrastructure, we leverage generous free tiers:

* **Frontend & Hosting:** Next.js deployed on Vercel. 
* **Authentication & File Storage:** Supabase. (Free tier provides secure Auth and S3-compatible storage buckets).
* **AI Engine (LLM & Vision):** Google Gemini Pro & Gemini Vision APIs (via AI Studio). Generous free tier with large context windows.
* **Graph Database:** Neo4j AuraDB. (Free instance perfect for storing Graph Nodes and Edges).
* **Metadata & Vector Storage:** Supabase pgvector. (Since Supabase is used for Auth/Storage, utilizing pgvector simplifies the stack and removes the need for MongoDB).
* **Asynchronous Processing:** Inngest. (Crucial for bypassing Vercel's 10-second timeout limit for serverless functions).
* **Graph Visualization:** `react-force-graph` or `react-flow`. (Modern React libraries for interactive graph rendering).

---

## 4. Architecture & Data Flow

### Phase 1: Constraints & Asynchronous Ingestion
To prevent free-tier API exhaustion and Vercel timeouts, a strict **2MB upload limit** is enforced on the frontend and validated on the backend.

1. **Upload:** User uploads a file. The frontend sends the file to Supabase Storage.
2. **Event Trigger:** The Next.js API registers the upload in the database with a status of `PROCESSING` and triggers an asynchronous background job via **Inngest**. The API immediately returns a 200 OK to the frontend so the user isn't kept waiting.

### Phase 2: Processing & Graph Extraction (The Background Worker)
The Inngest worker runs in the background, downloading the file from Supabase and routing it through specific handlers:
* **Images:** Routed to Gemini Vision API to describe and extract text.
* **Documents/Spreadsheets:** Routed to PDF parsers or Pandas.
* **Chunking & Rate Limiting:** The cleaned text is chunked. The worker includes a sleep/retry loop to respect Gemini's Requests-Per-Minute limits.
* **Extraction:** Each chunk is sent to the Gemini API to extract entities and relationships in strict JSON format.
* **Embedding:** Raw text chunks are converted into vectors using Gemini Embeddings.

### Phase 3: Storage & Multi-Tenant Data Isolation
Data isolation is critical.
* **Supabase pgvector:** Stores raw text chunks, their vector embeddings, and a `user_id` tag attached to every single entry.
* **Neo4j AuraDB:** Stores the extracted Entities (Nodes) and Relationships (Edges). The worker runs a semantic similarity check to merge duplicate entities. Crucially, every Node is tagged with a `user_id` property.
* **Why:** Guarantees zero data leakage between accounts using `WHERE user_id = X`.

### Phase 4: Hybrid Retrieval & The Chat UI
When a user asks a question in the Next.js frontend:
1. **Semantic Entry:** The question is embedded, and Supabase pgvector Vector Search finds the most relevant text chunks (filtered by `user_id`).
2. **Graph Traversal:** The system extracts key entities from the question and pings Neo4j to pull the surrounding web of relationships (filtered by `user_id`).
3. **Synthesis:** Vector context + Graph context + User question are combined into one prompt and sent to Gemini Pro.
4. **Display:** The frontend displays Gemini's answer. A split-screen UI uses `react-force-graph` to visually draw the specific graph subgraph, proving to the user exactly where the data came from.

---

## 5. Why This Project Stands Out
* **Cost Engineering:** Designing a system with hard constraints and asynchronous processing to prevent cloud billing nightmares and timeouts.
* **Advanced AI Architecture:** Moving past simple "wrapper" projects by implementing GraphRAG, multi-hop reasoning, and multi-modal handlers.
* **Full-Stack Security:** Real multi-tenancy and secure database filtering.
* **Complex UI/UX:** Going beyond a basic chat window by integrating real-time visual graph rendering.
