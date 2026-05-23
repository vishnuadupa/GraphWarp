"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/browser-client";
import { motion } from "framer-motion";
import {
  FileText, Loader2, Trash2, Upload, Plus,
  RefreshCw, AlertCircle, CheckCircle2, Clock,
} from "lucide-react";

interface Doc {
  id: string;
  filename: string;
  status: string;
  processing_step?: string | null;
  created_at: string;
  entity_count?: number;
  relation_count?: number;
  storage_path?: string;
}

const PROCESSING_STEPS = [
  { key: "downloading", label: "Download" },
  { key: "extracting",  label: "Extract" },
  { key: "embedding",   label: "Embed" },
  { key: "saving",      label: "Save" },
] as const;

function StatusBadge({ status, processingStep }: { status: string; processingStep?: string | null }) {
  if (status === "Completed")
    return (
      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-none text-xs font-mono font-bold bg-green-50 text-green-700 border border-green-200">
        <CheckCircle2 className="w-3 h-3" /> COMPLETED
      </span>
    );
  if (status === "Failed")
    return (
      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-none text-xs font-mono font-bold bg-red-50 text-red-700 border border-red-200">
        <AlertCircle className="w-3 h-3" /> FAILED
      </span>
    );

  // Show stepper when we have a processing_step
  if (processingStep) {
    const currentIdx = PROCESSING_STEPS.findIndex((s) => s.key === processingStep);
    const activeStep = PROCESSING_STEPS.find((s) => s.key === processingStep);
    return (
      <div className="flex items-center gap-1 shrink-0">
        {/* Mobile: Compact single active-step badge */}
        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-none text-xs font-mono font-bold bg-amber-50 text-amber-700 border border-amber-200 md:hidden shrink-0">
          <Loader2 className="w-3 h-3 animate-spin shrink-0" /> {activeStep ? activeStep.label.toUpperCase() : "PROCESSING"}
        </span>

        {/* Desktop: Full step-by-step indicator */}
        <div className="hidden md:flex items-center gap-1">
          {PROCESSING_STEPS.map((s, idx) => {
            const isDone    = idx < currentIdx;
            const isCurrent = idx === currentIdx;
            return (
              <div key={s.key} className="flex items-center gap-1">
                <div className={`flex items-center gap-1 px-1.5 py-0.5 rounded-none text-[10px] font-mono font-bold transition-all ${
                  isCurrent
                    ? "bg-amber-50 text-amber-800 border border-amber-300"
                    : isDone
                    ? "text-[var(--color-neutral)] opacity-70"
                    : "text-[var(--color-rule)]"
                }`}>
                  {isCurrent && <Loader2 className="w-2.5 h-2.5 animate-spin shrink-0" />}
                  {isDone && <CheckCircle2 className="w-2.5 h-2.5 shrink-0 text-green-600/80" />}
                  <span>{s.label.toUpperCase()}</span>
                </div>
                {idx < PROCESSING_STEPS.length - 1 && (
                  <span className="text-[var(--color-rule)] text-[10px]">›</span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // Fallback: generic processing badge
  return (
    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-none text-xs font-mono font-bold bg-amber-50 text-amber-700 border border-amber-200">
      <Loader2 className="w-3 h-3 animate-spin" /> PROCESSING
    </span>
  );
}

export default function DocumentsPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [documents, setDocuments] = useState<Doc[]>([]);
  const [loading, setLoading] = useState(true);
  const [reprocessing, setReprocessing] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState<Set<string>>(new Set());
  const [reprocessingAll, setReprocessingAll] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) { router.replace("/login"); return; }
      setUserId(user.id);
      setReady(true);
      fetchDocuments();
    });
  }, [router]);

  // Supabase Realtime — auto-update document rows when processing finishes
  useEffect(() => {
    if (!ready || !userId) return;
    const supabase = createClient();
    const channel = supabase
      .channel("documents-realtime")
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "documents" },
        (payload: any) => {
          if (payload.new?.user_id !== userId) return;
          setDocuments((prev) =>
            prev.map((d) => (d.id === payload.new.id ? { ...d, ...payload.new } : d))
          );
        }
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "documents" },
        (payload: any) => {
          if (payload.new?.user_id !== userId) return;
          setDocuments((prev) => {
            if (prev.some((d) => d.id === payload.new.id)) return prev;
            return [payload.new as Doc, ...prev];
          });
        }
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [ready, userId]);

  const fetchDocuments = async () => {
    try {
      setLoading(true);
      const res = await fetch("/api/documents");
      if (res.ok) {
        const data = await res.json();
        setDocuments(data.documents || []);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (doc: Doc) => {
    if (!confirm(`Remove "${doc.filename}" and its graph data?`)) return;
    setDeleting((prev) => new Set(prev).add(doc.id));
    try {
      const res = await fetch("/api/documents", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentId: doc.id }),
      });
      if (res.ok) setDocuments((prev) => prev.filter((d) => d.id !== doc.id));
      else alert("Failed to delete document.");
    } catch (err) {
      console.error(err);
    } finally {
      setDeleting((prev) => { const s = new Set(prev); s.delete(doc.id); return s; });
    }
  };

  const handleReprocess = async (doc: Doc) => {
    setReprocessing((prev) => new Set(prev).add(doc.id));
    try {
      const res = await fetch("/api/documents/reprocess", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentId: doc.id }),
      });
      if (res.ok) {
        setDocuments((prev) =>
          prev.map((d) => (d.id === doc.id ? { ...d, status: "Processing" } : d))
        );
      } else {
        alert("Failed to start reprocessing.");
      }
    } catch (err) {
      console.error(err);
    } finally {
      setReprocessing((prev) => { const s = new Set(prev); s.delete(doc.id); return s; });
    }
  };

  const stuckDocs = documents.filter((d) => d.status === "Processing" || d.status === "Failed");

  const handleReprocessAll = async () => {
    if (stuckDocs.length === 0) return;
    setReprocessingAll(true);
    for (const doc of stuckDocs) {
      try {
        const res = await fetch("/api/documents/reprocess", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ documentId: doc.id }),
        });
        if (res.ok) {
          setDocuments((prev) =>
            prev.map((d) => (d.id === doc.id ? { ...d, status: "Processing", processing_step: null } : d))
          );
        }
      } catch { /* continue */ }
    }
    setReprocessingAll(false);
  };

  if (!ready) return null;

  return (
    <div className="flex-1 overflow-y-auto p-8 lg:p-12 bg-[var(--color-paper)] text-[var(--color-ink)] min-h-full">
      <div className="max-w-5xl mx-auto space-y-8">

        {/* Header */}
        <div className="flex justify-between items-end border-b-[2px] border-[var(--color-rule)] pb-6">
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-1">
            <h1 className="text-3xl font-bold tracking-tighter uppercase text-[var(--color-ink)]">Documents</h1>
            <p className="text-[var(--color-neutral)] text-sm font-mono uppercase tracking-wider">
              {documents.length} file{documents.length !== 1 ? "s" : ""} ingested — live updates via Realtime
            </p>
          </motion.div>
          <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="flex items-center gap-2">
            {stuckDocs.length > 0 && (
              <button
                onClick={handleReprocessAll}
                disabled={reprocessingAll}
                className="flex items-center gap-1.5 px-4 py-2.5 bg-amber-50 hover:bg-amber-100 border-[2px] border-amber-300 text-amber-800 rounded-none font-mono uppercase font-bold text-xs disabled:opacity-50"
              >
                {reprocessingAll
                  ? <><Loader2 className="w-4 h-4 animate-spin" /> Queuing…</>
                  : <><RefreshCw className="w-4 h-4" /> Reprocess All ({stuckDocs.length})</>}
              </button>
            )}
            <Link href="/upload" className="flex items-center gap-2 px-5 py-3 bg-[var(--color-ink)] text-[var(--color-paper)] hover:opacity-85 rounded-none font-mono uppercase font-bold text-xs border-[2px] border-[var(--color-ink)] transition-opacity">
              <Plus className="w-4 h-4" /> Add Document
            </Link>
          </motion.div>
        </div>

        {/* Body */}
        {loading ? (
          <div className="flex justify-center py-20">
            <Loader2 className="w-8 h-8 animate-spin text-[var(--color-ink)]" />
          </div>
        ) : documents.length === 0 ? (
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
            className="flex flex-col items-center justify-center py-24 px-6 rounded-none border-[2px] border-[var(--color-rule)] border-dashed bg-[var(--color-paper-2)]">
            <div className="w-16 h-16 rounded-none border-[2px] border-[var(--color-rule)] bg-[var(--color-paper-3)] text-[var(--color-neutral)] flex items-center justify-center mb-6">
              <FileText className="w-8 h-8" />
            </div>
            <h3 className="text-xl font-bold tracking-tight mb-2 uppercase">No documents yet</h3>
            <p className="text-[var(--color-neutral)] text-center max-w-sm mb-8 leading-relaxed font-medium">Upload your first document to begin building your deterministic knowledge graph.</p>
            <Link href="/upload" className="flex items-center gap-2 px-6 py-3 bg-black text-[var(--color-paper)] hover:opacity-85 rounded-none font-mono uppercase font-bold text-sm">
              <Upload className="w-4 h-4" /> Upload Document
            </Link>
          </motion.div>
        ) : (
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
            className="rounded-none border-[2px] border-[var(--color-rule)] bg-[var(--color-paper)] overflow-x-auto">
            <table className="w-full min-w-[800px] text-left">
              <thead className="bg-[var(--color-paper-2)] border-b-[2px] border-[var(--color-rule)]">
                <tr>
                  <th className="px-6 py-4 text-xs font-bold text-[var(--color-neutral)] font-mono uppercase tracking-wider">File</th>
                  <th className="px-6 py-4 text-xs font-bold text-[var(--color-neutral)] font-mono uppercase tracking-wider">Status</th>
                  <th className="px-6 py-4 text-xs font-bold text-[var(--color-neutral)] font-mono uppercase tracking-wider">Entities</th>
                  <th className="px-6 py-4 text-xs font-bold text-[var(--color-neutral)] font-mono uppercase tracking-wider">Relations</th>
                  <th className="px-6 py-4 text-xs font-bold text-[var(--color-neutral)] font-mono uppercase tracking-wider">Uploaded</th>
                  <th className="px-6 py-4 text-xs font-bold text-[var(--color-neutral)] font-mono uppercase tracking-wider text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-rule)]">
                {documents.map((doc) => (
                  <tr key={doc.id} className="hover:bg-[var(--color-paper-2)] border-b border-[var(--color-rule)] transition-colors">
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-3">
                        <FileText className="w-4 h-4 text-[var(--color-neutral)] shrink-0" />
                        <span className="font-bold text-[var(--color-ink)] text-sm truncate max-w-xs">{doc.filename}</span>
                      </div>
                    </td>
                    <td className="px-6 py-4"><StatusBadge status={doc.status} processingStep={doc.processing_step} /></td>
                    <td className="px-6 py-4">
                      <span className="text-sm font-mono font-bold text-[var(--color-muted)] tabular-nums">
                        {doc.status === "Completed" ? (doc.entity_count ?? "—") : <span className="text-[var(--color-rule)]">—</span>}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      <span className="text-sm font-mono font-bold text-[var(--color-muted)] tabular-nums">
                        {doc.status === "Completed" ? (doc.relation_count ?? "—") : <span className="text-[var(--color-rule)]">—</span>}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      <span className="text-sm font-mono font-bold text-[var(--color-neutral)] flex items-center gap-1.5">
                        <Clock className="w-3 h-3" />
                        {new Date(doc.created_at).toLocaleDateString()}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex items-center justify-end gap-2">
                        {/* Reprocess */}
                        <button
                          onClick={() => handleReprocess(doc)}
                          disabled={reprocessing.has(doc.id) || doc.status === "Processing"}
                          title="Re-extract graph"
                          className="inline-flex items-center justify-center w-8 h-8 rounded-none border border-transparent hover:border-[var(--color-rule)] text-[var(--color-neutral)] hover:text-[var(--color-ink)] hover:bg-[var(--color-paper-2)] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                        >
                          <RefreshCw className={`w-3.5 h-3.5 ${reprocessing.has(doc.id) ? "animate-spin" : ""}`} />
                        </button>
                        {/* Delete */}
                        <button
                          onClick={() => handleDelete(doc)}
                          disabled={deleting.has(doc.id)}
                          title="Delete document"
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-none text-xs font-mono font-bold text-red-600 hover:text-red-700 bg-red-50 hover:bg-red-100 border border-red-200 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                        >
                          {deleting.has(doc.id)
                            ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Deleting...</>
                            : <><Trash2 className="w-3.5 h-3.5" /> Delete</>}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </motion.div>
        )}
      </div>
    </div>
  );
}
