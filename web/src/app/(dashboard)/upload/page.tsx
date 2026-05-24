"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/browser-client";
import UploadDropzone from "@/components/UploadDropzone";
import {
  ArrowRight, Loader2, CheckCircle2, XCircle, FileUp,
  FileText, AlertCircle,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

// Processing steps — must match what Inngest writes to processing_step
const PROCESSING_STEPS = [
  { key: "downloading", label: "Download" },
  { key: "extracting",  label: "Extract"  },
  { key: "saving",      label: "Save"     },
] as const;

type UploadPhase =
  | "idle"         // not yet started
  | "uploading"    // uploading to storage
  | "queued"       // Inngest job fired, waiting for first step
  | "processing"   // Inngest is running (has a processing_step)
  | "completed"    // status = Completed in DB
  | "failed"       // status = Failed in DB
  | "error";       // storage/API error before Inngest even started

interface UploadItem {
  filename:       string;
  phase:          UploadPhase;
  documentId?:    string;
  processingStep?: string | null;
  entityCount?:   number;
  relationCount?: number;
  errorMsg?:      string;
}

function ProcessingStepper({ step }: { step: string | null | undefined }) {
  const currentIdx = PROCESSING_STEPS.findIndex((s) => s.key === step);
  return (
    <div className="flex items-center gap-1 mt-1 ml-8">
      {PROCESSING_STEPS.map((s, idx) => {
        const isDone    = idx < currentIdx;
        const isCurrent = idx === currentIdx;
        return (
          <div key={s.key} className="flex items-center gap-1">
            <span className={`text-[10px] font-mono font-bold px-1.5 py-0.5 border transition-all ${
              isCurrent
                ? "bg-amber-50 text-amber-800 border-amber-300"
                : isDone
                ? "text-green-700 border-green-200 bg-green-50"
                : "text-[var(--color-rule)] border-[var(--color-rule)] bg-transparent"
            }`}>
              {isCurrent && <Loader2 className="inline w-2.5 h-2.5 animate-spin mr-0.5" />}
              {isDone    && <CheckCircle2 className="inline w-2.5 h-2.5 mr-0.5 text-green-600" />}
              {s.label.toUpperCase()}
            </span>
            {idx < PROCESSING_STEPS.length - 1 && (
              <span className="text-[var(--color-rule)] text-[10px]">›</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function UploadItemRow({ item }: { item: UploadItem }) {
  const icon = {
    idle:       <Loader2       className="w-5 h-5 text-[var(--color-neutral)] animate-spin" />,
    uploading:  <Loader2       className="w-5 h-5 text-[var(--color-ink)] animate-spin" />,
    queued:     <Loader2       className="w-5 h-5 text-amber-600 animate-spin" />,
    processing: <Loader2       className="w-5 h-5 text-amber-600 animate-spin" />,
    completed:  <CheckCircle2  className="w-5 h-5 text-green-600" />,
    failed:     <AlertCircle   className="w-5 h-5 text-red-600" />,
    error:      <XCircle       className="w-5 h-5 text-red-600" />,
  }[item.phase];

  const label = {
    idle:       "Waiting…",
    uploading:  "Uploading…",
    queued:     "Queued — waiting for worker",
    processing: `Processing — ${item.processingStep ?? "starting"}`,
    completed:  `Done — ${item.entityCount ?? 0} entities, ${item.relationCount ?? 0} relations`,
    failed:     "Processing failed",
    error:      item.errorMsg ?? "Upload error",
  }[item.phase];

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      className="flex flex-col p-4 bg-[var(--color-paper-2)] border-[2px] border-[var(--color-rule)] hover:bg-[var(--color-paper-3)] transition-colors"
    >
      <div className="flex items-center gap-3">
        {icon}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-bold text-[var(--color-ink)] truncate">{item.filename}</p>
          <p className="text-xs text-[var(--color-neutral)] font-mono mt-0.5">{label}</p>
        </div>
      </div>
      {(item.phase === "processing") && (
        <ProcessingStepper step={item.processingStep} />
      )}
    </motion.div>
  );
}

export default function UploadPage() {
  const router  = useRouter();
  const [userId, setUserId]   = useState<string | null>(null);
  const [items,  setItems]    = useState<UploadItem[]>([]);
  // Track active Supabase Realtime channels so we can clean them up
  const channelsRef = useRef<ReturnType<ReturnType<typeof createClient>["channel"]>[]>([]);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) { router.replace("/login"); return; }
      setUserId(user.id);
    });
    return () => {
      // Cleanup all realtime channels on unmount
      const supabase = createClient();
      channelsRef.current.forEach((ch) => supabase.removeChannel(ch));
    };
  }, [router]);

  /** Subscribe to realtime updates for a single document */
  const subscribeToDoc = useCallback((documentId: string, filename: string) => {
    const supabase = createClient();
    const channel  = supabase
      .channel(`upload-doc-${documentId}`)
      .on(
        "postgres_changes",
        {
          event:  "UPDATE",
          schema: "public",
          table:  "documents",
          filter: `id=eq.${documentId}`,
        },
        (payload: any) => {
          const row = payload.new;
          setItems((prev) =>
            prev.map((item) => {
              if (item.documentId !== documentId) return item;
              if (row.status === "Completed") {
                return {
                  ...item,
                  phase:         "completed",
                  processingStep: null,
                  entityCount:   row.entity_count   ?? 0,
                  relationCount: row.relation_count ?? 0,
                };
              }
              if (row.status === "Failed") {
                return { ...item, phase: "failed" };
              }
              // Still processing — update the step label
              return {
                ...item,
                phase:         "processing",
                processingStep: row.processing_step ?? null,
              };
            }),
          );
        },
      )
      .subscribe();

    channelsRef.current.push(channel);
  }, []);

  const handleFilesSelected = useCallback(
    async (files: File[]) => {
      if (!userId) return;
      const supabase = createClient();

      for (const file of files) {
        const path = `${userId}/${Date.now()}-${file.name}`;

        // Add the item in uploading state
        setItems((prev) => [{ filename: file.name, phase: "uploading" }, ...prev]);

        // 1. Upload to Supabase Storage
        const { error: uploadError } = await supabase.storage
          .from("documents")
          .upload(path, file);

        if (uploadError) {
          setItems((prev) =>
            prev.map((s) =>
              s.filename === file.name && s.phase === "uploading"
                ? { ...s, phase: "error", errorMsg: uploadError.message }
                : s,
            ),
          );
          continue;
        }

        // 2. Trigger Inngest via API
        let documentId: string | undefined;
        try {
          const res = await fetch("/api/upload", {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({ filePath: path, filename: file.name }),
          });

          if (!res.ok) {
            const errBody = await res.json().catch(() => ({}));
            const errMsg  = errBody?.error || errBody?.details || `Server error ${res.status}`;
            setItems((prev) =>
              prev.map((s) =>
                s.filename === file.name && s.phase === "uploading"
                  ? { ...s, phase: "error", errorMsg: errMsg }
                  : s,
              ),
            );
            continue;
          }

          const body = await res.json();
          documentId = body.document?.id;
        } catch {
          setItems((prev) =>
            prev.map((s) =>
              s.filename === file.name && s.phase === "uploading"
                ? { ...s, phase: "error", errorMsg: "API unreachable" }
                : s,
            ),
          );
          continue;
        }

        // 3. Mark as queued + subscribe to realtime updates for this document
        setItems((prev) =>
          prev.map((s) =>
            s.filename === file.name && s.phase === "uploading"
              ? { ...s, phase: "queued", documentId }
              : s,
          ),
        );

        if (documentId) {
          subscribeToDoc(documentId, file.name);
        }
      }
    },
    [userId, subscribeToDoc],
  );

  const anyCompleted  = items.some((s) => s.phase === "completed");
  const anyActive     = items.some((s) => ["uploading", "queued", "processing"].includes(s.phase));

  if (!userId) return null;

  return (
    <div className="flex-1 overflow-y-auto p-8 lg:p-12 bg-[var(--color-paper)] text-[var(--color-ink)] min-h-full">
      <div className="max-w-4xl mx-auto space-y-12">

        {/* Header */}
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-4 text-center">
          <div className="w-16 h-16 rounded-none border-[2px] border-[var(--color-rule)] bg-[var(--color-paper-2)] text-[var(--color-neutral)] flex items-center justify-center mx-auto mb-6">
            <FileUp className="w-8 h-8" />
          </div>
          <h1 className="text-4xl font-bold tracking-tighter uppercase text-[var(--color-ink)]">Ingest Documents</h1>
          <p className="text-[var(--color-neutral)] text-lg max-w-2xl mx-auto leading-relaxed">
            Drop any file up to 1 MB. It uploads to your private storage, then the graph is extracted automatically in the background.
          </p>
        </motion.div>

        {/* Dropzone */}
        <motion.div initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: 0.1 }}>
          <UploadDropzone onFilesSelected={handleFilesSelected} />
        </motion.div>

        {/* Per-file status list */}
        {items.length > 0 && (
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
            <div className="font-bold text-[var(--color-neutral)] uppercase tracking-widest text-xs font-mono ml-1">
              Processing Status
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <AnimatePresence>
                {items.map((item, i) => (
                  <UploadItemRow key={`${item.filename}-${i}`} item={item} />
                ))}
              </AnimatePresence>
            </div>

            {/* Processing note — shown while any file is still in flight */}
            {anyActive && (
              <motion.p
                initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                className="text-xs text-[var(--color-neutral)] font-mono text-center pt-2"
              >
                Graph extraction runs in the background — you can leave this page, it will finish.
              </motion.p>
            )}

            {/* CTA — only appears once at least one file is fully ready */}
            {anyCompleted && (
              <motion.div
                initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.3 }}
                className="pt-8 flex flex-col sm:flex-row items-center justify-center gap-4"
              >
                <Link
                  href="/chat"
                  className="group flex items-center gap-2 px-8 py-4 bg-[var(--color-ink)] text-[var(--color-paper)] hover:opacity-85 rounded-none font-mono uppercase font-bold text-sm border-[2px] border-[var(--color-ink)] transition-opacity"
                >
                  Start chatting
                  <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
                </Link>
                <Link
                  href="/documents"
                  className="flex items-center gap-2 px-6 py-4 border-[2px] border-[var(--color-rule)] text-[var(--color-neutral)] hover:text-[var(--color-ink)] hover:border-[var(--color-ink)] font-mono uppercase font-bold text-sm transition-colors"
                >
                  <FileText className="w-4 h-4" />
                  Manage documents
                </Link>
              </motion.div>
            )}
          </motion.div>
        )}
      </div>
    </div>
  );
}
