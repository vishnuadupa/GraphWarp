"use client";

import { useState, useCallback } from "react";

interface UploadDropzoneProps {
  /** Called with the selected files — wire up to your API route when ready */
  onFilesSelected?: (files: File[]) => void;
}

const ACCEPTED_TYPES = [".docx", ".txt", ".csv", ".xlsx", ".xls"];
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

export default function UploadDropzone({ onFilesSelected }: UploadDropzoneProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [queued, setQueued] = useState<File[]>([]);

  const handleFiles = useCallback(
    (files: FileList | null) => {
      if (!files) return;
      const arr = Array.from(files);
      const validFiles = arr.filter(f => {
        const ext = "." + f.name.split(".").pop()?.toLowerCase();
        if (!ACCEPTED_TYPES.includes(ext)) {
          alert(`File ${f.name} has an unsupported format. Accepted formats: ${ACCEPTED_TYPES.join(", ")}`);
          return false;
        }
        if (f.size > MAX_FILE_SIZE) {
          alert(`File ${f.name} exceeds the 10MB limit.`);
          return false;
        }
        return true;
      });
      if (validFiles.length === 0) return;
      setQueued((prev) => [...prev, ...validFiles]);
      onFilesSelected?.(validFiles);
    },
    [onFilesSelected]
  );

  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const onDragLeave = () => setIsDragging(false);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    handleFiles(e.dataTransfer.files);
  };

  const onInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    handleFiles(e.target.files);
    e.target.value = "";
  };

  const removeFile = (index: number) =>
    setQueued((prev) => prev.filter((_, i) => i !== index));

  return (
    <div className="w-full max-w-2xl mx-auto space-y-4">
      {/* Drop target */}
      <label
        htmlFor="file-upload"
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className={`
          border-[2px] border-dashed border-[var(--color-rule)] bg-[var(--color-paper)] rounded-none flex flex-col items-center justify-center gap-4
          cursor-pointer select-none p-12 transition-all duration-300 hover:border-[var(--color-ink)] hover:bg-[var(--color-paper-2)]
          ${isDragging ? "border-[var(--color-ink)] bg-[var(--color-paper-3)] scale-[1.01]" : ""}
        `}
        style={{ minHeight: 220 }}
      >
        <input
          id="file-upload"
          type="file"
          multiple
          accept={ACCEPTED_TYPES.join(",")}
          className="sr-only"
          onChange={onInputChange}
        />

        {/* Icon */}
        <div
          className="w-16 h-16 rounded-none flex items-center justify-center transition-transform duration-300 border-[2px]"
          style={{
            background: "var(--color-paper-2)",
            borderColor: "var(--color-rule)",
            transform: isDragging ? "scale(1.1)" : "scale(1)",
          }}
        >
          <svg
            width="28"
            height="28"
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--color-ink)"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
        </div>

        <div className="text-center space-y-1">
          <p className="text-base font-bold text-[var(--color-ink)]">
            {isDragging ? "Drop to add to graph" : "Drop documents here"}
          </p>
          <p className="text-sm text-[var(--color-neutral)] font-medium">
            or{" "}
            <span className="text-[var(--color-ink)] font-bold hover:opacity-85 underline underline-offset-2">
              browse files
            </span>
          </p>
          <p className="text-xs text-[var(--color-neutral)] font-mono uppercase tracking-widest pt-1">
            {ACCEPTED_TYPES.join("  ·  ")} (Max 10MB)
          </p>
        </div>
      </label>

      {/* Queue */}
      {queued.length > 0 && (
        <ul className="space-y-2">
          {queued.map((file, i) => (
            <li
              key={`${file.name}-${i}`}
              className="rounded-none border-[2px] border-[var(--color-rule)] bg-[var(--color-paper)] flex items-center justify-between gap-3 px-4 py-3 text-sm"
            >
              <div className="flex items-center gap-3 min-w-0">
                <span
                  className="shrink-0 w-7 h-7 rounded-none border-[1px] border-[var(--color-rule)] bg-[var(--color-paper-2)] flex items-center justify-center text-xs font-mono font-bold text-[var(--color-neutral)]"
                >
                  {file.name.split(".").pop()?.toUpperCase().slice(0, 3)}
                </span>
                <span className="truncate text-[var(--color-ink)] font-bold">{file.name}</span>
                <span className="shrink-0 text-[var(--color-neutral)] font-mono text-xs">
                  {(file.size / 1024).toFixed(0)} KB
                </span>
              </div>
              <button
                onClick={() => removeFile(i)}
                className="shrink-0 text-[var(--color-neutral)] hover:text-red-600 transition-colors"
                aria-label="Remove file"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
