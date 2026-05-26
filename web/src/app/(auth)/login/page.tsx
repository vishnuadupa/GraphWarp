"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/browser-client";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const supabase = createClient();
      const { error: authError } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (authError) {
        setError(authError.message);
        return;
      }

      // Smart redirect:
      // - No documents at all  → /upload  (onboarding)
      // - Has completed docs   → /chat    (returning user, ready to query)
      // - Has docs but none ready yet → /documents (check processing status)
      try {
        const res = await fetch("/api/documents");
        if (res.ok) {
          const { documents = [] } = await res.json();
          if (documents.length === 0) {
            window.location.href = "/upload";
            return;
          }
          const hasReady = documents.some((d: any) => d.status === "Completed");
          window.location.href = hasReady ? "/chat" : "/documents";
          return;
        }
      } catch { /* fall through to default */ }

      window.location.href = "/chat";
    } catch {
      setError("An unexpected error occurred. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <Link href="/" className="auth-wordmark uppercase tracking-widest text-[var(--color-ink)] hover:opacity-80 transition-opacity">
          GRAPHWARP
        </Link>
        <h1 className="auth-heading">Log in</h1>
        <p className="auth-lede">Continue to your GraphRAG dashboard.</p>

        {error && <div className="form-error">{error}</div>}

        <form onSubmit={handleSubmit} className="form-stack">
          <div className="form-field">
            <label className="form-label">Email address</label>
            <input
              type="email"
              required
              className="form-input"
              placeholder="name@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>

          <div className="form-field">
            <div className="flex items-center justify-between">
              <label className="form-label">Password</label>
              <Link href="/forgot-password" className="text-[var(--text-xs,11px)] text-[var(--color-neutral)] hover:text-[var(--color-ink)] transition-colors">
                Forgot password?
              </Link>
            </div>
            <input
              type="password"
              required
              className="form-input"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          <button type="submit" disabled={loading} className="btn-ink-full mt-2">
            {loading ? "Authenticating..." : "Sign in"}
          </button>
        </form>

        <p className="mt-6 text-[10px] text-amber-800 border border-amber-200 bg-amber-50/50 p-2.5 leading-[1.6]">
          <strong>⚠️ Disclaimer:</strong> GraphWarp is a personal portfolio and educational demonstration. Please do not upload sensitive, proprietary, or personal private documents.
        </p>

        <div className="auth-footer mt-6">
          Don't have an account? <Link href="/signup">Get started</Link>
        </div>
      </div>
    </div>
  );
}
