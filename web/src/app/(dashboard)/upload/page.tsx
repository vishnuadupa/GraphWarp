"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/browser-client";
import UploadDropzone from "@/components/UploadDropzone";
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
    <div className="upload-layout">
      <h1 className="upload-heading">Ingest Documents</h1>
      <p className="upload-lede">
        Drop any file up to 1 MB. It uploads securely to your private tenant bucket, then extracts entities and semantic embeddings in the background.
      </p>

      <div className="demo__panel">
        <UploadDropzone onFilesSelected={handleFilesSelected} />
      </div>

      {statuses.length > 0 && (
        <div className="upload-status">
          <div className="font-medium text-[var(--color-ink)] mb-2 uppercase tracking-widest text-xs">Upload Status</div>
          <div className="flex flex-col gap-2">
            {statuses.map((s, i) => (
              <div
                key={i}
                className="flex items-center justify-between p-3 rounded-md bg-[var(--color-paper-2)] border border-[var(--color-rule)]"
              >
                <div className="flex items-center gap-3">
                  {s.state === "uploading" && <Loader2 className="w-4 h-4 text-[var(--color-neutral)] animate-spin" />}
                  {s.state === "done" && <CheckCircle2 className="w-4 h-4 text-green-600" />}
                  {s.state === "error" && <XCircle className="w-4 h-4 text-red-600" />}
                  
                  <span className="text-sm font-medium text-[var(--color-ink)]">
                    {s.filename}
                  </span>
                </div>
                {s.message && (
                  <span className="text-xs text-[var(--color-neutral)]">{s.message}</span>
                )}
              </div>
            ))}
          </div>

          {statuses.some(s => s.state === "done") && (
            <div className="pt-6 flex justify-start">
              <Link
                href="/chat"
                className="group flex items-center gap-2 text-sm font-bold text-[var(--color-ink)] border-b border-[var(--color-ink)] pb-1 hover:text-[var(--color-neutral)] hover:border-[var(--color-neutral)] transition-colors"
              >
                Next Step: Ask the Graph
                <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
              </Link>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
