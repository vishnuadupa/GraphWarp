"use client";

import { useState, useEffect, ReactNode, useCallback } from "react";
import { createClient } from "@/lib/supabase/browser-client";
import { AlertCircle, CheckCircle2, X } from "lucide-react";

const ALLOWED_EXTENSIONS = new Set(['.docx', '.txt', '.csv', '.xlsx', '.xls', '.pdf']);
const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2 MB

interface Toast { id: number; msg: string; ok: boolean }
let seq = 0;

export function GlobalDropzone({ children }: { children: ReactNode }) {
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const pushToast = useCallback((msg: string, ok = false) => {
    const id = ++seq;
    setToasts((prev) => [...prev, { id, msg, ok }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 5000);
  }, []);

  const handleFiles = useCallback(async (files: File[]) => {
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { pushToast("You must be logged in to upload files."); return; }

    const validFiles = files.filter((f) => {
      const ext = "." + f.name.split(".").pop()?.toLowerCase();
      if (!ALLOWED_EXTENSIONS.has(ext)) {
        pushToast(`"${f.name}" — unsupported format. Accepted: ${[...ALLOWED_EXTENSIONS].join(", ")}`);
        return false;
      }
      if (f.size > MAX_FILE_SIZE) {
        pushToast(`"${f.name}" exceeds the 2 MB limit (${(f.size / 1024 / 1024).toFixed(1)} MB).`);
        return false;
      }
      return true;
    });

    if (validFiles.length === 0) return;
    setIsUploading(true);

    let uploaded = 0;
    for (const file of validFiles) {
      try {
        const path = `${user.id}/${Date.now()}-${file.name}`;
        const { error: uploadError } = await supabase.storage.from("documents").upload(path, file);
        if (uploadError) throw uploadError;

        const res = await fetch("/api/upload", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filePath: path, filename: file.name }),
        });

        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          pushToast(`"${file.name}" — ${data.error ?? "upload failed"}`);
        } else {
          uploaded++;
        }
      } catch (err: any) {
        pushToast(`"${file.name}" — ${err?.message ?? "upload failed"}`);
      }
    }

    if (uploaded > 0) {
      pushToast(`${uploaded} file${uploaded > 1 ? "s" : ""} uploaded — graph extraction running in background.`, true);
    }
    setIsUploading(false);
  }, [pushToast]);

  useEffect(() => {
    const enter = (e: DragEvent) => { if (e.dataTransfer?.types.includes("Files")) { e.preventDefault(); setIsDragging(true); } };
    const over  = (e: DragEvent) => { e.preventDefault(); setIsDragging(true); };
    const leave = (e: DragEvent) => { e.preventDefault(); if (!e.relatedTarget || (e.relatedTarget as Element).nodeName === "HTML") setIsDragging(false); };
    const drop  = (e: DragEvent) => { e.preventDefault(); setIsDragging(false); if (e.dataTransfer?.files?.length) handleFiles(Array.from(e.dataTransfer.files)); };

    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover",  over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop",      drop);
    return () => { window.removeEventListener("dragenter", enter); window.removeEventListener("dragover", over); window.removeEventListener("dragleave", leave); window.removeEventListener("drop", drop); };
  }, [handleFiles]);

  return (
    <>
      {children}

      {/* Global drag overlay */}
      {isDragging && (
        <div className="fixed inset-0 z-[9999] bg-black/40 backdrop-blur-sm flex items-center justify-center pointer-events-none">
          <div className="bg-[var(--color-paper)] border-[3px] border-dashed border-[var(--color-ink)] px-16 py-10 text-center shadow-2xl">
            <p className="text-lg font-bold uppercase tracking-widest font-mono text-[var(--color-ink)]">Drop to add to graph</p>
            <p className="text-xs text-[var(--color-neutral)] font-mono mt-2">
              {[...ALLOWED_EXTENSIONS].join("  ·  ")} — max 2 MB
            </p>
          </div>
        </div>
      )}

      {/* Uploading indicator */}
      {isUploading && (
        <div className="fixed bottom-6 right-6 z-[9999] flex items-center gap-3 px-5 py-3 bg-[var(--color-paper)] border-[2px] border-[var(--color-rule)] shadow-lg text-sm font-mono font-bold text-[var(--color-ink)]">
          <div className="w-4 h-4 border-2 border-[var(--color-rule)] border-t-[var(--color-ink)] rounded-none animate-spin shrink-0" />
          Uploading &amp; ingesting…
        </div>
      )}

      {/* Toast stack */}
      <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[9998] flex flex-col gap-2 w-full max-w-sm px-4">
        {toasts.map((t) => (
          <div key={t.id} className={`flex items-start gap-3 px-4 py-3 border-[2px] shadow text-xs font-mono font-bold ${t.ok ? "bg-green-50 border-green-300 text-green-800" : "bg-red-50 border-red-300 text-red-800"}`}>
            {t.ok ? <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" /> : <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />}
            <span className="flex-1">{t.msg}</span>
            <button onClick={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))} className="shrink-0 hover:opacity-70">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        ))}
      </div>
    </>
  );
}
