"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/browser-client";
import UploadDropzone from "@/components/UploadDropzone";
import { ArrowRight, Loader2, CheckCircle2, XCircle, FileUp } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

interface UploadStatus {
  filename: string;
  state: "uploading" | "done" | "error";
  message?: string;
}

export default function UploadPage() {
  const router = useRouter();
  const [userId, setUserId] = useState<string | null>(null);
  const [statuses, setStatuses] = useState<UploadStatus[]>([]);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) {
        router.replace("/login");
      } else {
        setUserId(user.id);
      }
    });
  }, [router]);

  const handleFilesSelected = useCallback(
    async (files: File[]) => {
      if (!userId) return;
      const supabase = createClient();

      for (const file of files) {
        const path = `${userId}/${Date.now()}-${file.name}`;

        setStatuses((prev) => [
          { filename: file.name, state: "uploading" },
          ...prev,
        ]);

        const { error: uploadError } = await supabase.storage
          .from("documents")
          .upload(path, file);

        if (uploadError) {
          setStatuses((prev) =>
            prev.map((s) =>
              s.filename === file.name && s.state === "uploading"
                ? { ...s, state: "error", message: uploadError.message }
                : s
            )
          );
          continue;
        }

        try {
          const res = await fetch("/api/upload", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              filePath: path,
              filename: file.name,
            }),
          });

          if (!res.ok) {
            const errBody = await res.json().catch(() => ({}));
            const errMsg = errBody?.error || errBody?.details || `Server error ${res.status}`;
            setStatuses((prev) =>
              prev.map((s) =>
                s.filename === file.name && s.state === "uploading"
                  ? { ...s, state: "error", message: errMsg }
                  : s
              )
            );
            continue;
          }

          setStatuses((prev) =>
            prev.map((s) =>
              s.filename === file.name && s.state === "uploading"
                ? { ...s, state: "done" }
                : s
            )
          );
        } catch (err) {
          setStatuses((prev) =>
            prev.map((s) =>
              s.filename === file.name && s.state === "uploading"
                ? { ...s, state: "error", message: "API unreachable" }
                : s
            )
          );
        }
      }
    },
    [userId]
  );

  if (!userId) return null;

  return (
    <div className="flex-1 overflow-y-auto p-8 lg:p-12 bg-[var(--color-paper)] text-[var(--color-ink)] min-h-full">
      <div className="max-w-4xl mx-auto space-y-12">
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-4 text-center">
          <div className="w-16 h-16 rounded-none border-[2px] border-[var(--color-rule)] bg-[var(--color-paper-2)] text-[var(--color-neutral)] flex items-center justify-center mx-auto mb-6">
            <FileUp className="w-8 h-8" />
          </div>
          <h1 className="text-4xl font-bold tracking-tighter uppercase text-[var(--color-ink)]">Ingest Documents</h1>
          <p className="text-[var(--color-neutral)] text-lg max-w-2xl mx-auto leading-relaxed">
            Drop any file up to 1 MB. It uploads securely to your private tenant bucket, then extracts entities and semantic embeddings in the background.
          </p>
        </motion.div>

        <motion.div initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: 0.1 }}>
          <UploadDropzone onFilesSelected={handleFilesSelected} />
        </motion.div>

        {statuses.length > 0 && (
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
            <div className="font-bold text-[var(--color-neutral)] uppercase tracking-widest text-xs font-mono ml-1">Upload Status</div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <AnimatePresence>
                {statuses.map((s, i) => (
                  <motion.div
                    key={`${s.filename}-${i}`}
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    className="flex flex-col p-4 rounded-none bg-[var(--color-paper-2)] border-[2px] border-[var(--color-rule)] hover:bg-[var(--color-paper-3)] transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      {s.state === "uploading" && <Loader2 className="w-5 h-5 text-[var(--color-ink)] animate-spin" />}
                      {s.state === "done" && <CheckCircle2 className="w-5 h-5 text-green-600" />}
                      {s.state === "error" && <XCircle className="w-5 h-5 text-red-600" />}
                      
                      <span className="text-sm font-bold text-[var(--color-ink)] truncate flex-1">
                        {s.filename}
                      </span>
                    </div>
                    {s.message && (
                      <span className="text-xs text-red-600 mt-2 ml-8 font-mono">{s.message}</span>
                    )}
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>

            {statuses.some(s => s.state === "done") && (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.5 }} className="pt-8 flex justify-center">
                <Link
                  href="/chat"
                  className="group flex items-center gap-2 px-8 py-4 bg-[var(--color-ink)] text-[var(--color-paper)] hover:opacity-85 rounded-none font-mono uppercase font-bold text-sm border-[2px] border-[var(--color-ink)] shadow-md hover:shadow-lg transition-all"
                >
                  Next Step: Ask the Graph
                  <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
                </Link>
              </motion.div>
            )}
          </motion.div>
        )}
      </div>
    </div>
  );
}
