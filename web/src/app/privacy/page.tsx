"use client";

import Link from "next/link";
import { ArrowLeft, Shield } from "lucide-react";

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-[var(--color-paper)] text-[var(--color-ink)] selection:bg-[var(--color-ink)] selection:text-[var(--color-paper)] font-sans flex flex-col">
      {/* Navigation */}
      <nav className="flex items-center justify-between px-6 py-8">
        <Link href="/" className="flex items-center gap-2 font-mono text-sm tracking-[0.15em] font-bold text-[var(--color-ink)] uppercase">
          <ArrowLeft className="w-4 h-4" /> GraphWarp
        </Link>
      </nav>

      {/* Main Content */}
      <main className="flex-1 max-w-3xl mx-auto px-6 py-12 md:py-24 space-y-12">
        <div className="border-b-[2px] border-[var(--color-rule)] pb-8">
          <div className="w-12 h-12 rounded-none border-[2px] border-[var(--color-rule)] bg-[var(--color-paper-2)] text-[var(--color-neutral)] flex items-center justify-center mb-6">
            <Shield className="w-6 h-6 text-[var(--color-ink)]" />
          </div>
          <h1 className="text-4xl md:text-5xl font-bold tracking-tighter uppercase mb-4">Privacy Policy</h1>
          <p className="text-xs font-mono text-[var(--color-neutral)] uppercase tracking-widest">
            Last Updated: May 2026 · Personal Portfolio Project Disclosure
          </p>
        </div>

        {/* Project Disclaimer Banner */}
        <div className="p-6 bg-amber-50 border-[2px] border-amber-300 text-amber-900 font-mono text-xs leading-relaxed space-y-2">
          <p className="font-bold uppercase tracking-wider">⚠️ EXPERIMENTAL PROJECT DISCLAIMER</p>
          <p>
            GraphWarp is a personal portfolio and educational demonstration project created by an individual developer. 
            It is not a commercial product, and no business entity exists. By using this service, you acknowledge that 
            your data is processed solely for educational demonstration purposes. 
            <strong> Please do not upload sensitive, proprietary, or personal private documents (e.g. financial records, medical documents, trade secrets).</strong>
          </p>
        </div>

        {/* Policy Sections */}
        <div className="space-y-12 font-sans text-sm leading-[1.7] text-[var(--color-muted)]">
          <section className="space-y-4">
            <h2 className="text-lg font-bold font-mono text-[var(--color-ink)] uppercase tracking-wide">01 — What We Collect</h2>
            <p>
              GraphWarp collects two primary pieces of information:
            </p>
            <ul className="list-disc list-inside space-y-2 pl-2">
              <li>
                <strong>Account Credentials:</strong> Your email address is collected during signup solely to establish your 
                user profile and authenticate your sessions securely via Supabase Auth.
              </li>
              <li>
                <strong>Uploaded Documents:</strong> Text, CSV, PDF, DOCX, and image files that you choose to ingest into 
                the application to build your personal knowledge graph.
              </li>
            </ul>
          </section>

          <section className="space-y-4">
            <h2 className="text-lg font-bold font-mono text-[var(--color-ink)] uppercase tracking-wide">02 — How Data is Processed</h2>
            <p>
              To deliver GraphRAG features, your uploaded documents undergo automated parsing and structural translation:
            </p>
            <ul className="list-disc list-inside space-y-2 pl-2">
              <li>
                <strong>Graph Extraction:</strong> Cleaned text and image contents are sent in-memory to vision-capable and 
                text-based large language models (LLMs) via OpenRouter to extract entities and relationships.
              </li>
              <li>
                <strong>Database Storage:</strong> The extracted structural graph nodes and edges are stored in a private, 
                secure Neo4j AuraDB graph database instance, tagged strictly with your unique user identification ID.
              </li>
              <li>
                <strong>No Parametric Training:</strong> None of your uploaded files, data, or chat queries are sent or used 
                to train public LLMs or proprietary machine learning models.
              </li>
            </ul>
          </section>

          <section className="space-y-4">
            <h2 className="text-lg font-bold font-mono text-[var(--color-ink)] uppercase tracking-wide">03 — Sharing & Security Guarantees</h2>
            <p>
              Because this is a non-commercial personal project, I enforce absolute integrity on data sharing:
            </p>
            <ul className="list-disc list-inside space-y-2 pl-2">
              <li>
                <strong>No Selling:</strong> Your data is never sold, leased, traded, or shared with third-party advertising networks.
              </li>
              <li>
                <strong>Multi-Tenant Isolation:</strong> Strict database Row Level Security (RLS) policies in Postgres and 
                user scoping constraints in Neo4j completely isolate your data, ensuring it remains visible only to you.
              </li>
              <li>
                <strong>Strictly Necessary Cookies:</strong> We only use functional cookies generated by Supabase to securely 
                maintain your session tokens. We run no tracking, marketing, or behavioral analytics trackers.
              </li>
            </ul>
          </section>

          <section className="space-y-4">
            <h2 className="text-lg font-bold font-mono text-[var(--color-ink)] uppercase tracking-wide">04 — Deletion & User Control</h2>
            <p>
              You maintain 100% control over your data. At any time, you can:
            </p>
            <ul className="list-disc list-inside space-y-2 pl-2">
              <li>
                Delete individual documents directly from the <strong>Documents Dashboard</strong>. Deleting a document 
                triggers a complete, atomic purging of all related edges, files, and orphaned nodes from both Supabase 
                Storage and Neo4j.
              </li>
              <li>
                For complete account wipeout, please open a request directly on the project's public GitHub repository by submitting a new issue: 
                <a href="https://github.com/vishnuadupa/GraphWeave/issues" target="_blank" rel="noopener noreferrer" className="font-mono text-[var(--color-ink)] font-bold ml-1 underline">GitHub Issues</a>.
              </li>
            </ul>
          </section>
        </div>

        {/* Footer */}
        <div className="border-t-[2px] border-[var(--color-rule)] pt-8 text-xs font-mono text-[var(--color-neutral)] text-center">
          <p>GraphWarp Project · Built for Demonstration Purposes</p>
        </div>
      </main>
    </div>
  );
}
