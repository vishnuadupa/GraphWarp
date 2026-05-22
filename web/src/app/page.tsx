import Link from "next/link";
import UploadDropzone from "@/components/UploadDropzone";

const stages = [
  {
    num: "1.0",
    name: "INGEST",
    heading: "Drop a file. Any format.",
    desc: "PDF, spreadsheet, or image — up to 2 MB. The frontend writes it to Supabase Storage, registers it with status PROCESSING, and fires an Inngest background job. The API returns 200 immediately — before a single entity has been extracted.",
    tech: "Supabase Storage · Inngest · Next.js API Route",
  },
  {
    num: "2.0",
    name: "EXTRACT",
    heading: "Entities and relationships surface.",
    desc: "Each text chunk is routed to Gemini Pro with a strict JSON schema: entities become typed nodes, co-occurrences become typed edges. A semantic similarity pass runs before writing — duplicate variants of the same entity merge rather than fork the graph.",
    tech: "Gemini Pro · Gemini Vision · pgvector embeddings",
  },
  {
    num: "3.0",
    name: "GRAPH",
    heading: "Neo4j receives the structure.",
    desc: "Every node and every edge carries a user_id tag. Cypher queries are scoped to your workspace at the query layer — not at the application layer. Your data never touches another tenant's subgraph, by construction.",
    tech: "Neo4j AuraDB · Cypher · Row-level isolation",
  },
  {
    num: "4.0",
    name: "QUERY",
    heading: "Ask in plain language.",
    desc: "Your question is embedded and matched against pgvector chunks (filtered by user_id), then used to extract key entities and traverse the graph. Vector context and graph context are synthesised into one Gemini Pro answer — cited, multi-hop, grounded in explicit data relationships.",
    tech: "pgvector hybrid retrieval · Neo4j graph traversal · Gemini Pro synthesis",
  },
];

export default function Home() {
  return (
    <div className="page">

      {/* ── Nav: N5 Floating pill ── */}
      <header className="nav-wrap">
        <nav className="nav-pill" aria-label="Site navigation">
          <Link href="/" className="nav-pill__wordmark">
            GraphRAG
          </Link>
          <div className="nav-pill__links">
            <Link href="/login" className="nav-pill__link">
              Sign in
            </Link>
            <Link href="/signup" className="nav-pill__cta">
              Get started
            </Link>
          </div>
        </nav>
      </header>

      {/* ── Hero — 2-col: headline left, lede + CTAs right ── */}
      <section className="hero" aria-label="Hero">
        <div className="container">
          <div className="hero__grid">
            <div>
              <h1 className="hero__headline">
                Your documents,<br />
                structurally<br />
                understood.
              </h1>
            </div>
            <div>
              <p className="hero__lede">
                GraphRAG extracts entities and relationships from your files,
                builds a live knowledge graph, and answers questions that traverse
                the entire web of meaning — not just keyword matches.
              </p>
              <div className="hero__actions">
                <Link href="/signup" className="btn-ink">
                  Build your graph →
                </Link>
                <a href="#demo" className="btn-ghost">
                  Try the demo
                </a>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Workflow stages: F4 Step sequence ── */}
      <section className="stages" aria-label="How it works">
        <div className="container">
          {stages.map((stage) => (
            <article key={stage.num} className="stage">
              {/* Hairline divider with stage number inline */}
              <div className="stage__divider" aria-hidden="true">
                <span className="stage__divider-num">{stage.num}</span>
                <div className="stage__divider-line" />
              </div>

              {/* Large dim number — decorative structural */}
              <div className="stage__num-display" aria-hidden="true">
                {stage.num}
              </div>

              {/* Stage name label — directly beneath number, vertical stack */}
              <p className="stage__name-label">{stage.name}</p>

              {/* Stage heading */}
              <h2 className="stage__heading">{stage.heading}</h2>

              {/* Body: description + tech annotation */}
              <div className="stage__body">
                <p className="stage__desc">{stage.desc}</p>
                <p className="stage__tech">{stage.tech}</p>
              </div>
            </article>
          ))}
        </div>
      </section>

      {/* ── Demo — dark panel wrapping the dropzone ── */}
      <section id="demo" className="demo" aria-label="Upload demo">
        <div className="container">
          {/* Subtle divider */}
          <div className="demo__rule" aria-hidden="true">
            <span className="demo__rule-glyph">—</span>
            <div className="stage__divider-line" />
          </div>

          <div className="demo__grid">
            <div>
              <h2 className="demo__heading">
                Start at 1.0 →
              </h2>
              <p className="demo__lede">
                Drop any document. The uploader connects to the full pipeline —
                Supabase, Inngest, Neo4j, Gemini — once you have signed in.
              </p>
            </div>
            <div className="demo__panel">
              <UploadDropzone />
            </div>
          </div>
        </div>
      </section>

      {/* ── Footer: Ft2 Inline single line ── */}
      <footer className="footer-strip">
        <div className="container">
          <div className="footer-strip__inner">
            <span>GraphRAG Knowledge Engine</span>
            <div className="footer-strip__right">
              <span>Neo4j · Supabase · Inngest · Gemini</span>
              <span className="footer-strip__sep" aria-hidden="true">·</span>
              <span>© 2026</span>
            </div>
          </div>
        </div>
      </footer>

    </div>
  );
}
