"use client";

import { useState, useEffect, ReactNode } from "react";
import { createClient } from "@/lib/supabase/browser-client";

export function GlobalDropzone({ children }: { children: ReactNode }) {
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);

  useEffect(() => {
    const handleDragEnter = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) {
        e.preventDefault();
        setIsDragging(true);
      }
    };
    const handleDragOver = (e: DragEvent) => {
      e.preventDefault();
      setIsDragging(true);
    };
    const handleDragLeave = (e: DragEvent) => {
      e.preventDefault();
      if (!e.relatedTarget || (e.relatedTarget as Element).nodeName === "HTML") {
        setIsDragging(false);
      }
    };
    const handleDrop = (e: DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
        handleFiles(Array.from(e.dataTransfer.files));
      }
    };

    window.addEventListener("dragenter", handleDragEnter);
    window.addEventListener("dragover", handleDragOver);
    window.addEventListener("dragleave", handleDragLeave);
    window.addEventListener("drop", handleDrop);

    return () => {
      window.removeEventListener("dragenter", handleDragEnter);
      window.removeEventListener("dragover", handleDragOver);
      window.removeEventListener("dragleave", handleDragLeave);
      window.removeEventListener("drop", handleDrop);
    };
  }, []);

  const handleFiles = async (files: File[]) => {
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      alert("You must be logged in to upload files.");
      return;
    }

    const ALLOWED_EXTENSIONS = new Set(['.docx', '.txt', '.csv', '.xlsx', '.xls']);
    const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

    const validFiles = files.filter(f => {
      const ext = "." + f.name.split(".").pop()?.toLowerCase();
      if (!ALLOWED_EXTENSIONS.has(ext)) {
        alert(`File ${f.name} has an unsupported format. Accepted formats: ${[...ALLOWED_EXTENSIONS].join(", ")}`);
        return false;
      }
      if (f.size > MAX_FILE_SIZE) {
        alert(`File ${f.name} exceeds the 10MB limit.`);
        return false;
      }
      return true;
    });

    if (validFiles.length === 0) return;

    setIsUploading(true);

    try {
      for (const file of validFiles) {
        const path = `${user.id}/${Date.now()}-${file.name}`;
        
        const { error: uploadError } = await supabase.storage
          .from("documents")
          .upload(path, file);

        if (uploadError) throw uploadError;

        await fetch("/api/upload", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filePath: path, filename: file.name }),
        });
      }
      alert(`Successfully uploaded ${files.length} file(s). They are now being ingested into the Graph.`);
    } catch (err: any) {
      alert(`Upload failed: ${err.message}`);
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <>
      {children}
      
      {isDragging && (
        <div 
          style={{
            position: 'fixed', inset: 0, zIndex: 9999,
            backgroundColor: 'rgba(0,0,0,0.4)', backdropFilter: 'blur(8px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            border: '8px dashed var(--primary-500)', transition: 'all 0.2s'
          }}
        >
          <div style={{ background: 'white', padding: '2rem 4rem', borderRadius: '1rem', textAlign: 'center', boxShadow: '0 25px 50px -12px rgb(0 0 0 / 0.25)' }}>
             <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--primary-600)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{margin: '0 auto 1rem'}}>
               <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
               <polyline points="17 8 12 3 7 8"/>
               <line x1="12" y1="3" x2="12" y2="15"/>
             </svg>
             <h2 style={{ fontSize: '1.5rem', fontWeight: 600, color: 'var(--gray-900)' }}>Drop to Add Knowledge</h2>
             <p style={{ color: 'var(--gray-600)', marginTop: '0.5rem' }}>Your files will be instantly parsed and added to the Graph.</p>
          </div>
        </div>
      )}

      {isUploading && (
        <div style={{
          position: 'fixed', bottom: '2rem', right: '2rem', zIndex: 9999,
          background: '#fff', padding: '1rem', borderRadius: '8px',
          boxShadow: '0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)',
          display: 'flex', alignItems: 'center', gap: '1rem', border: '1px solid var(--gray-200)'
        }}>
           <div className="spinner" style={{width: '20px', height: '20px', border: '2px solid var(--gray-200)', borderTopColor: 'var(--primary-600)', borderRadius: '50%', animation: 'spin 1s linear infinite'}}></div>
           <span style={{color: 'var(--gray-900)', fontWeight: 500, fontSize: '0.875rem'}}>Uploading & Ingesting...</span>
        </div>
      )}
    </>
  );
}
