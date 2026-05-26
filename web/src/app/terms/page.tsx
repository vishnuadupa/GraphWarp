"use client";

import Link from "next/link";
import { ArrowLeft, Scale } from "lucide-react";

export default function TermsPage() {
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
            <Scale className="w-6 h-6 text-[var(--color-ink)]" />
          </div>
          <h1 className="text-4xl md:text-5xl font-bold tracking-tighter uppercase mb-4">Terms of Service</h1>
          <p className="text-xs font-mono text-[var(--color-neutral)] uppercase tracking-widest">
            Last Updated: May 2026 · Personal Portfolio Project Terms
          </p>
        </div>

        {/* Project Disclaimer Banner */}
        <div className="p-6 bg-amber-50 border-[2px] border-amber-300 text-amber-900 font-mono text-xs leading-relaxed space-y-2">
          <p className="font-bold uppercase tracking-wider">⚠️ NOT A COMMERCIAL PLATFORM</p>
          <p>
            By accessing or using GraphWarp, you acknowledge that this is a **personal, non-commercial portfolio and educational demonstration project**. 
            It is provided for visual evaluation and technical demonstration. **No commercial warranties, service level agreements (SLAs), or guarantees are provided.**
          </p>
        </div>

        {/* Terms Sections */}
        <div className="space-y-12 font-sans text-sm leading-[1.7] text-[var(--color-muted)]">
          <section className="space-y-4">
            <h2 className="text-lg font-bold font-mono text-[var(--color-ink)] uppercase tracking-wide">01 — Acceptance of Terms</h2>
            <p>
              By signing up for an account and utilizing the document upload or chat interfaces on this site, you agree to 
              be bound by these simple project terms. If you do not agree, please do not upload files or register credentials.
            </p>
          </section>

          <section className="space-y-4">
            <h2 className="text-lg font-bold font-mono text-[var(--color-ink)] uppercase tracking-wide">02 — Use Restrictions & Prohibited Data</h2>
            <p>
              GraphWarp is designed for general relational evaluation of text structure. Because this is an experimental project 
              hosted on a personal cloud database budget, you are strictly prohibited from uploading:
            </p>
            <ul className="list-disc list-inside space-y-2 pl-2">
              <li>Any document containing protected health information (PHI) or personal financial records.</li>
              <li>Proprietary business secrets, NDAs, or corporate files subject to strict copyright/privacy constraints.</li>
              <li>Malicious payloads, scripts, or files designed to exploit parser pipelines.</li>
            </ul>
            <p className="font-medium text-[var(--color-ink)]">
              Any accounts found uploading prohibited data or attempting to disrupt the serverless infrastructure will be permanently deleted without warning.
            </p>
          </section>

          <section className="space-y-4">
            <h2 className="text-lg font-bold font-mono text-[var(--color-ink)] uppercase tracking-wide">03 — NO WARRANTIES ("AS IS")</h2>
            <div className="p-6 border-[2px] border-[var(--color-rule)] bg-[var(--color-paper-2)] font-mono text-xs text-[var(--color-neutral)] uppercase leading-relaxed space-y-4">
              <p className="font-bold text-[var(--color-ink)]">THE PLATFORM IS PROVIDED ON AN "AS IS" AND "AS AVAILABLE" BASIS.</p>
              <p>
                TO THE MAXIMUM EXTENT PERMITTED BY LAW, THE DEVELOPER DISCLAIMS ALL WARRANTIES, EXPRESS OR IMPLIED, 
                INCLUDING BUT NOT LIMITED TO IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, 
                AND NON-INFRINGEMENT.
              </p>
              <p>
                NO WARRANTY IS MADE THAT THE SERVICE WILL BE UNINTERRUPTED, SECURE, COMPLETELY ACCURATE, OR ERROR-FREE, 
                OR THAT UPLOADED DATA WILL BE SAFELY STORED OR PRESERVED PERMANENTLY.
              </p>
            </div>
          </section>

          <section className="space-y-4">
            <h2 className="text-lg font-bold font-mono text-[var(--color-ink)] uppercase tracking-wide">04 — LIMITATION OF LIABILITY</h2>
            <div className="p-6 border-[2px] border-[var(--color-rule)] bg-[var(--color-paper-2)] font-mono text-xs text-[var(--color-neutral)] uppercase leading-relaxed space-y-4">
              <p>
                IN NO EVENT SHALL THE INDIVIDUAL DEVELOPER OF THIS PROJECT BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, 
                SPECIAL, CONSEQUENTIAL, OR EXEMPLARY DAMAGES (INCLUDING, BUT NOT LIMITED TO, LOSS OF DATA, LOSS OF GOODWILL, 
                WORK STOPPAGE, SERVER TIMEOUTS, OR API EXHAUSTION DISRUPTIONS) ARISING OUT OF OR IN CONNECTION WITH THE 
                USE OF OR INABILITY TO USE THIS SERVICE.
              </p>
              <p>
                YOU ASSUME SOLE RESPONSIBILITY FOR YOUR COMPLIANCE WITH ANY DATA PRIVACY DIRECTIVES IN YOUR JURISDICTION.
              </p>
            </div>
          </section>

          <section className="space-y-4">
            <h2 className="text-lg font-bold font-mono text-[var(--color-ink)] uppercase tracking-wide">05 — Contact Information</h2>
            <p>
              For inquiries regarding these terms, data deletions, or general technical questions about the architecture, 
              please open a request or report directly by submitting a new issue on the project's public GitHub repository: 
              <a href="https://github.com/vishnuadupa/GraphWeave/issues" target="_blank" rel="noopener noreferrer" className="font-mono text-[var(--color-ink)] font-bold ml-1 underline">GitHub Issues</a>.
            </p>
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
