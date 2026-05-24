"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/browser-client";
import { CheckCircle } from "lucide-react";

export default function ResetPasswordPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }

    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }

    setLoading(true);

    try {
      const supabase = createClient();
      const { error: updateError } = await supabase.auth.updateUser({ password });

      if (updateError) {
        setError(updateError.message);
        return;
      }

      setDone(true);

      // Give user a moment to read the success message, then redirect
      setTimeout(() => router.push("/chat"), 2500);
    } catch {
      setError("An unexpected error occurred. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  if (done) {
    return (
      <div className="auth-shell">
        <div className="auth-card">
          <Link href="/" className="auth-wordmark uppercase tracking-widest text-[var(--color-ink)] hover:opacity-80 transition-opacity">
            GRAPHWEAVE
          </Link>
          <div className="flex flex-col items-center gap-4 py-6 text-center">
            <CheckCircle className="w-10 h-10 text-[var(--color-ink)]" />
            <h1 className="auth-heading">Password updated</h1>
            <p className="auth-lede">
              Your password has been changed successfully.<br />
              Redirecting you to the app&hellip;
            </p>
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
        <h1 className="auth-heading">New password</h1>
        <p className="auth-lede">Choose a strong password for your account.</p>

        {error && <div className="form-error">{error}</div>}

        <form onSubmit={handleSubmit} className="form-stack">
          <div className="form-field">
            <label className="form-label">New password</label>
            <input
              type="password"
              required
              minLength={8}
              className="form-input"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          <div className="form-field">
            <label className="form-label">Confirm password</label>
            <input
              type="password"
              required
              minLength={8}
              className="form-input"
              placeholder="••••••••"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </div>

          <button type="submit" disabled={loading} className="btn-ink-full mt-2">
            {loading ? "Updating..." : "Update password"}
          </button>
        </form>
      </div>
    </div>
  );
}
