"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/browser-client";
import UploadDropzone from "@/components/UploadDropzone";
import { motion } from "framer-motion";
import { ArrowRight, Loader2, CheckCircle2, XCircle } from "lucide-react";

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
          await fetch("/api/upload", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              filePath: path,
              filename: file.name,
            }),
          });

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
    <div className="flex-1 overflow-y-auto p-8 lg:p-12">
      <div className="max-w-3xl mx-auto space-y-12">
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="space-y-4"
        >
          <h1 className="text-4xl font-bold tracking-tight">Ingest Documents</h1>
          <p className="text-white/50 text-lg max-w-xl">
            Drop any file up to 1 MB. It uploads securely to your private tenant bucket, then Inngest extracts entities and semantic embeddings in the background.
          </p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
        >
          <UploadDropzone onFilesSelected={handleFilesSelected} />
        </motion.div>

        {statuses.length > 0 && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="space-y-4 pt-8 border-t border-white/[0.08]"
          >
            <h3 className="font-medium text-white/80">Upload Status</h3>
            <div className="space-y-3">
              {statuses.map((s, i) => (
                <div
                  key={i}
                  className="flex items-center justify-between p-4 rounded-xl bg-white/[0.02] border border-white/[0.08]"
                >
                  <div className="flex items-center gap-4">
                    {s.state === "uploading" && <Loader2 className="w-5 h-5 text-indigo-400 animate-spin" />}
                    {s.state === "done" && <CheckCircle2 className="w-5 h-5 text-green-400" />}
                    {s.state === "error" && <XCircle className="w-5 h-5 text-red-400" />}
                    
                    <span className="text-sm font-medium text-white/80">
                      {s.filename}
                    </span>
                  </div>
                  {s.message && (
                    <span className="text-xs text-white/40">{s.message}</span>
                  )}
                </div>
              ))}
            </div>

            {statuses.some(s => s.state === "done") && (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="pt-6 flex justify-end"
              >
                <Link
                  href="/chat"
                  className="flex items-center gap-2 px-6 py-3 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl font-medium transition-all"
                >
                  Next Step: Ask the Graph
                  <ArrowRight className="w-4 h-4" />
                </Link>
              </motion.div>
            )}
          </motion.div>
        )}
      </div>
    </div>
  );
}
