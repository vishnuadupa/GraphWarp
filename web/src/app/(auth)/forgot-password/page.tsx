"use client";

import { useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/browser-client";
import { MailCheck } from "lucide-react";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const supabase = createClient();
      const { error: authError } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${location.origin}/auth/callback?next=/reset-password`,
      });

      if (authError) {
        setError(authError.message);
        return;
      }

      setSent(true);
    } catch {
      setError("An unexpected error occurred. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  if (sent) {
    return (
      <div className="auth-shell">
        <div className="auth-card">
          <Link href="/" className="auth-wordmark uppercase tracking-widest text-[var(--color-ink)] hover:opacity-80 transition-opacity">
            GRAPHWEAVE
          </Link>
          <div className="flex flex-col items-center gap-4 py-6 text-center">
            <MailCheck className="w-10 h-10 text-[var(--color-ink)]" />
            <h1 className="auth-heading">Check your inbox</h1>
            <p className="auth-lede">
              I sent a password reset link to <strong>{email}</strong>.<br />
              Click it to choose a new password.
            </p>
            <Link href="/login" className="btn-ink-full mt-2 w-full text-center">
              Back to sign in
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
          GRAPHWEAVE
        </Link>
        <h1 className="auth-heading">Reset password</h1>
        <p className="auth-lede">Enter your email and I&apos;ll send you a reset link.</p>

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

          <button type="submit" disabled={loading} className="btn-ink-full mt-2">
            {loading ? "Sending..." : "Send reset link"}
          </button>
        </form>

        <div className="auth-footer mt-6">
          Remembered it? <Link href="/login">Sign in</Link>
        </div>
      </div>
    </div>
  );
}
