"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/browser-client";
import UploadDropzone from "@/components/UploadDropzone";

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

        // 1. Upload to Supabase Storage
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

        // 2. Notify the backend API with the storage path (not a public URL —
        //    the bucket is private; the server downloads it with the service key)
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
    <div className="dash-shell">
      <header className="dash-topbar">
        <Link href="/" className="dash-wordmark">GraphWeave</Link>
        <nav className="dash-topbar-right">
          <Link href="/chat" className="dash-topbar-link">Chat</Link>
          <Link href="/upload" className="dash-topbar-link">Upload</Link>
          <Link href="/documents" className="dash-topbar-link">My Documents</Link>
          <LogoutButton />
        </nav>
      </header>

      <main className="dash-content">
        <div className="upload-layout">
          <h1 className="upload-heading">Ingest a document.</h1>
          <p className="upload-lede">
            Drop any file up to 2 MB. It uploads to Supabase Storage, then Inngest
            extracts entities and builds your knowledge graph in the background.
          </p>

          <div className="demo__panel">
            <UploadDropzone onFilesSelected={handleFilesSelected} />
          </div>

          {statuses.length > 0 && (
            <div className="upload-status">
              {statuses.map((s, i) => (
                <div
                  key={i}
                  className={`upload-status-item upload-status-item--${
                    s.state === "done"
                      ? "ok"
                      : s.state === "error"
                      ? "err"
                      : "busy"
                  }`}
                >
                  <span>
                    {s.state === "done"
                      ? "✓"
                      : s.state === "error"
                      ? "✗"
                      : "·"}
                  </span>
                  <span>
                    {s.filename}
                    {s.message ? ` — ${s.message}` : ""}
                  </span>
                </div>
              ))}
              
              {statuses.some(s => s.state === "done") && (
                <div className="mt-8 flex justify-center">
                  <Link href="/chat" className="btn-ink-full text-center" style={{ width: '100%' }}>
                    Next Step: Ask the Knowledge Graph →
                  </Link>
                </div>
              )}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

function LogoutButton() {
  const router = useRouter();

  const handleLogout = async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.replace("/login");
    router.refresh();
  };

  return (
    <button
      onClick={handleLogout}
      className="dash-topbar-link"
      style={{ background: "none", border: "none", cursor: "pointer", padding: 0 }}
    >
      Sign out
    </button>
  );
}
