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
    <div className="flex-1 overflow-y-auto p-8 lg:p-12 bg-[#0A0A0B] text-white">
      <div className="max-w-4xl mx-auto space-y-12">
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-4 text-center">
          <div className="w-16 h-16 rounded-2xl bg-indigo-500/10 text-indigo-400 flex items-center justify-center mx-auto mb-6">
            <FileUp className="w-8 h-8" />
          </div>
          <h1 className="text-4xl font-bold tracking-tight">Ingest Documents</h1>
          <p className="text-white/50 text-lg max-w-2xl mx-auto">
            Drop any file up to 1 MB. It uploads securely to your private tenant bucket, then extracts entities and semantic embeddings in the background.
          </p>
        </motion.div>

        <motion.div initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: 0.1 }}>
          <div className="bg-white/[0.02] border border-white/[0.08] rounded-3xl p-2 shadow-2xl">
            <UploadDropzone onFilesSelected={handleFilesSelected} />
          </div>
        </motion.div>

        {statuses.length > 0 && (
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
            <div className="font-medium text-white/40 uppercase tracking-widest text-xs ml-1">Upload Status</div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <AnimatePresence>
                {statuses.map((s, i) => (
                  <motion.div
                    key={`${s.filename}-${i}`}
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    className="flex flex-col p-4 rounded-2xl bg-white/[0.03] border border-white/[0.08] hover:bg-white/[0.05] transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      {s.state === "uploading" && <Loader2 className="w-5 h-5 text-indigo-400 animate-spin" />}
                      {s.state === "done" && <CheckCircle2 className="w-5 h-5 text-green-400" />}
                      {s.state === "error" && <XCircle className="w-5 h-5 text-red-400" />}
                      
                      <span className="text-sm font-medium text-white/90 truncate flex-1">
                        {s.filename}
                      </span>
                    </div>
                    {s.message && (
                      <span className="text-xs text-red-400/80 mt-2 ml-8">{s.message}</span>
                    )}
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>

            {statuses.some(s => s.state === "done") && (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.5 }} className="pt-8 flex justify-center">
                <Link
                  href="/chat"
                  className="group flex items-center gap-2 px-8 py-4 bg-white text-black hover:bg-white/90 rounded-2xl font-semibold transition-all shadow-[0_0_40px_rgba(255,255,255,0.1)] hover:shadow-[0_0_60px_rgba(255,255,255,0.2)]"
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
