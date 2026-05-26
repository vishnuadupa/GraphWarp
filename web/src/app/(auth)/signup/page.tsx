"use client";

import { useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/browser-client";
import { MailCheck } from "lucide-react";

export default function SignupPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const supabase = createClient();
      const { error: authError } = await supabase.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: `${location.origin}/auth/callback`,
        },
      });

      if (authError) {
        setError(authError.message);
        return;
      }

      // Don't redirect — user must confirm email first
      setConfirmed(true);
    } catch {
      setError("An unexpected error occurred. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  if (confirmed) {
    return (
      <div className="auth-shell">
        <div className="auth-card">
          <Link href="/" className="auth-wordmark uppercase tracking-widest text-[var(--color-ink)] hover:opacity-80 transition-opacity">
            GRAPHWARP
          </Link>
          <div className="flex flex-col items-center gap-4 py-6 text-center">
            <MailCheck className="w-10 h-10 text-[var(--color-ink)]" />
            <h1 className="auth-heading">Check your inbox</h1>
            <p className="auth-lede">
              I sent a confirmation link to <strong>{email}</strong>.<br />
              Click it to activate your account, then sign in.
            </p>
            <Link href="/login" className="btn-ink-full mt-2 w-full text-center">
              Go to sign in
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <Link href="/" className="auth-wordmark uppercase tracking-widest text-[var(--color-ink)] hover:opacity-80 transition-opacity">
          GRAPHWARP
        </Link>
        <h1 className="auth-heading">Create account</h1>
        <p className="auth-lede">Start building your custom knowledge graph.</p>

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
            <label className="form-label">Password</label>
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
            {loading ? "Creating..." : "Sign up"}
          </button>
        </form>

        <p className="mt-6 text-[10px] text-amber-800 border border-amber-200 bg-amber-50/50 p-2.5 leading-[1.6]">
          <strong>⚠️ Disclaimer:</strong> GraphWarp is a personal portfolio and educational demonstration. Please do not upload sensitive, proprietary, or personal private documents.
        </p>

        <div className="auth-footer mt-6">
          Already have an account? <Link href="/login">Log in</Link>
        </div>
      </div>
    </div>
  );
}
