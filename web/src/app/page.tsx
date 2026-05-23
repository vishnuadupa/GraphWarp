"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { Network, Search, Zap, Shield, ChevronRight } from "lucide-react";

export default function Home() {
  return (
    <div className="min-h-screen bg-[#0A0A0B] text-white selection:bg-indigo-500/30">
      {/* Navigation */}
      <nav className="fixed top-0 inset-x-0 z-50 border-b border-white/[0.08] bg-[#0A0A0B]/80 backdrop-blur-xl">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-indigo-500 flex items-center justify-center">
              <Network className="w-5 h-5 text-white" />
            </div>
            <span className="font-semibold text-lg tracking-tight">GraphWeave</span>
          </div>
          <div className="flex items-center gap-4 text-sm font-medium">
            <Link href="/login" className="text-white/70 hover:text-white transition-colors">
              Sign In
            </Link>
            <Link
              href="/signup"
              className="bg-white text-black px-4 py-2 rounded-lg hover:bg-white/90 transition-all active:scale-95"
            >
              Get Started Free
            </Link>
          </div>
        </div>
      </nav>

      {/* Hero Section */}
      <section className="relative pt-32 pb-20 overflow-hidden">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-indigo-900/20 via-[#0A0A0B] to-[#0A0A0B]"></div>
        
        <div className="max-w-7xl mx-auto px-6 relative z-10 text-center">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
            className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-indigo-500/10 border border-indigo-500/20 text-indigo-300 text-sm font-medium mb-8"
          >
            <span className="w-2 h-2 rounded-full bg-indigo-400 animate-pulse"></span>
            Introducing Zero-Hallucination GraphRAG
          </motion.div>

          <motion.h1
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.1 }}
            className="text-6xl md:text-8xl font-bold tracking-tight mb-6 bg-gradient-to-b from-white to-white/60 bg-clip-text text-transparent"
          >
            Chat with your data. <br />
            <span className="italic font-serif text-indigo-400">Deterministically.</span>
          </motion.h1>

          <motion.p
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.2 }}
            className="text-xl text-white/50 max-w-2xl mx-auto mb-10 leading-relaxed"
          >
            Stop trusting probabilistic text chunks. GraphWeave extracts a strict semantic knowledge graph from your documents, ensuring a 0% hallucination rate.
          </motion.p>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.3 }}
            className="flex flex-col sm:flex-row items-center justify-center gap-4"
          >
            <Link
              href="/signup"
              className="group flex items-center justify-center gap-2 w-full sm:w-auto px-8 py-4 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl font-medium transition-all active:scale-95"
            >
              Start Building Free
              <ChevronRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
            </Link>
            <Link
              href="#features"
              className="w-full sm:w-auto px-8 py-4 bg-white/5 hover:bg-white/10 text-white rounded-xl font-medium transition-all"
            >
              Read the Whitepaper
            </Link>
          </motion.div>
        </div>
      </section>

      {/* Social Proof */}
      <section className="border-y border-white/5 bg-white/[0.02] py-10">
        <div className="max-w-7xl mx-auto px-6 text-center">
          <p className="text-sm font-medium text-white/40 mb-8 uppercase tracking-widest">
            Trusted by research teams worldwide
          </p>
          <div className="flex flex-wrap justify-center gap-12 opacity-40 grayscale">
            {/* Stub logos */}
            <div className="text-xl font-bold font-serif">Acmecorp</div>
            <div className="text-xl font-bold">Stark Industries</div>
            <div className="text-xl font-bold tracking-tighter">GLOBEX</div>
            <div className="text-xl font-bold italic">Soylent</div>
            <div className="text-xl font-bold uppercase">Initech</div>
          </div>
        </div>
      </section>

      {/* Features Grid */}
      <section id="features" className="py-32">
        <div className="max-w-7xl mx-auto px-6">
          <div className="grid md:grid-cols-3 gap-8">
            <FeatureCard 
              icon={<Search />}
              title="Semantic Entity Resolution"
              description="We embed the structural nodes, not the paragraphs. Traverse the graph without losing the context of the user's synonyms."
            />
            <FeatureCard 
              icon={<Zap />}
              title="Parallel Extraction"
              description="Fan-out background workers tear through massive PDFs in seconds using Gemini 3.1 Flash Lite."
            />
            <FeatureCard 
              icon={<Shield />}
              title="Strict Tenant Isolation"
              description="Enterprise-grade RLS in Postgres and hardcoded Cypher driver constraints guarantee your data never leaks."
            />
          </div>
        </div>
      </section>
    </div>
  );
}

function FeatureCard({ icon, title, description }: { icon: React.ReactNode, title: string, description: string }) {
  return (
    <div className="p-8 rounded-3xl bg-white/[0.03] border border-white/[0.08] hover:bg-white/[0.05] transition-colors">
      <div className="w-12 h-12 rounded-xl bg-indigo-500/20 text-indigo-400 flex items-center justify-center mb-6">
        {icon}
      </div>
      <h3 className="text-xl font-semibold mb-3">{title}</h3>
      <p className="text-white/50 leading-relaxed">{description}</p>
    </div>
  );
}
