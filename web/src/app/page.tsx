import Link from "next/link";
import { ArrowRight } from "lucide-react";
import LandingGraph from "@/components/LandingGraph";

export default function Home() {
  return (
    <div className="min-h-screen bg-[var(--color-paper)] text-[var(--color-ink)] selection:bg-[var(--color-ink)] selection:text-[var(--color-paper)] font-sans flex flex-col">
      {/* N9 Edge-aligned minimal */}
      <nav className="flex items-center justify-between px-6 py-8">
        <Link href="/" className="font-mono text-sm tracking-[0.15em] font-bold text-[var(--color-ink)] uppercase">
          GraphWeave
        </Link>
        <div className="flex items-center gap-8">
          <Link href="/login" className="text-sm font-medium text-[var(--color-neutral)] hover:text-[var(--color-ink)] transition-colors hidden sm:block">
            Log in
          </Link>
          <Link
            href="/signup"
            className="text-sm font-medium px-6 py-3 bg-[var(--color-ink)] text-[var(--color-paper)] hover:opacity-80 transition-opacity"
          >
            Start free
          </Link>
        </div>
      </nav>

      {/* 03 Marquee Hero */}
      <main className="flex-1 flex flex-col">
        <section className="px-6 pt-12 pb-32 md:pt-24 md:pb-48 flex flex-col justify-end min-h-[60svh] border-b-[2px] border-[var(--color-rule)] relative overflow-hidden">
          <div className="absolute inset-y-0 right-0 w-full md:w-[60%] h-full opacity-60 md:opacity-90 z-0">
            <LandingGraph />
          </div>

          <div className="relative z-10 pointer-events-none max-w-7xl w-full flex flex-col justify-end">
            <h1 className="text-[clamp(3.5rem,10vw,10rem)] font-bold tracking-tighter leading-[0.85] text-[var(--color-ink)] uppercase mb-8">
              Chat with<br />
              your data.<br />
              <span className="text-[var(--color-neutral)]">Deterministically.</span>
            </h1>
            
            <div className="flex flex-col md:flex-row gap-8 md:gap-24 items-start md:items-end mt-8">
              <p className="text-xl max-w-xl text-[var(--color-muted)] leading-[1.6] pointer-events-auto">
                Stop trusting probabilistic text chunks. GraphWeave extracts a strict semantic knowledge graph from your documents, ensuring a 0% hallucination rate.
              </p>
              <div className="flex items-center gap-6 pointer-events-auto">
                <Link
                  href="/signup"
                  className="group flex items-center gap-3 text-lg font-bold text-[var(--color-ink)] border-b-2 border-[var(--color-ink)] pb-1 hover:text-[var(--color-neutral)] hover:border-[var(--color-neutral)] transition-colors"
                >
                  Start free
                  <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
                </Link>
                <Link
                  href="/login"
                  className="text-lg font-medium text-[var(--color-neutral)] hover:text-[var(--color-ink)] transition-colors"
                >
                  Sign in
                </Link>
              </div>
            </div>
          </div>
        </section>

        {/* Feature Grid - Brutal borders */}
        <section className="grid grid-cols-1 md:grid-cols-3 border-b-[2px] border-[var(--color-rule)]">
          <FeatureCard
            num="01"
            title="Graph Extraction"
            desc="Every upload is torn apart by a vision-capable LLM and reassembled as a strict entity-relationship graph. No chunks, no embeddings drift."
          />
          <FeatureCard
            num="02"
            title="Deterministic Answers"
            desc="Answers are synthesised from exact graph traversal — not fuzzy vector similarity. Every fact is traceable back to a source file."
          />
          <FeatureCard
            num="03"
            title="Tenant Isolation"
            desc="Enterprise RLS and strict Cypher driver constraints guarantee your graph data never leaks to other users."
          />
        </section>

        {/* Ft4 Dense colophon footer */}
        <footer className="px-6 py-16 grid grid-cols-1 md:grid-cols-12 gap-12 font-mono text-xs leading-[1.7] text-[var(--color-neutral)] bg-[var(--color-paper-2)]">
          <div className="md:col-span-6 max-w-md">
            <div className="font-bold text-[var(--color-ink)] uppercase tracking-widest mb-4">GraphWeave Systems</div>
            <p className="mb-6">
              A premium knowledge engine built for deterministic retrieval.
              Architecture relies on Neo4j graph traversal and OpenRouter LLMs for
              zero-hallucination factual synthesis.
            </p>
            <p>Built in 2026. All rights reserved.</p>
          </div>
          
          <div className="md:col-span-3">
            <div className="font-bold text-[var(--color-ink)] uppercase tracking-widest mb-4">Platform</div>
            <div className="flex flex-col gap-2">
              <Link href="/login" className="hover:text-[var(--color-ink)] transition-colors">Sign In</Link>
              <Link href="/signup" className="hover:text-[var(--color-ink)] transition-colors">Create Account</Link>
              <Link href="/upload" className="hover:text-[var(--color-ink)] transition-colors">Ingestion Pipeline</Link>
            </div>
          </div>

          <div className="md:col-span-3">
            <div className="font-bold text-[var(--color-ink)] uppercase tracking-widest mb-4">Legal</div>
            <div className="flex flex-col gap-2">
              <span className="hover:text-[var(--color-ink)] transition-colors cursor-pointer">Privacy Policy</span>
              <span className="hover:text-[var(--color-ink)] transition-colors cursor-pointer">Terms of Service</span>
            </div>
          </div>
        </footer>
      </main>
    </div>
  );
}

function FeatureCard({ num, title, desc }: { num: string, title: string, desc: string }) {
  return (
    <div className="p-10 md:p-16 border-b-[2px] md:border-b-0 md:border-r-[2px] border-[var(--color-rule)] last:border-0 hover:bg-[var(--color-paper-2)] transition-colors group cursor-default flex flex-col justify-between h-full">
      <div className="font-mono text-sm font-bold text-[var(--color-neutral)] mb-12">
        {num} —
      </div>
      <div>
        <h3 className="text-2xl font-bold tracking-tight text-[var(--color-ink)] mb-4">{title}</h3>
        <p className="text-[var(--color-muted)] leading-[1.6]">{desc}</p>
      </div>
    </div>
  );
}
