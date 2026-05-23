"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/browser-client";
import { motion } from "framer-motion";
import { Network, Loader2 } from "lucide-react";

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

      router.push("/upload");
      router.refresh();
    } catch {
      setError("An unexpected error occurred. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#0A0A0B] flex">
      {/* Left Form Side */}
      <div className="flex-1 flex flex-col justify-center px-8 sm:px-12 lg:px-24">
        <div className="max-w-md w-full mx-auto">
          <Link href="/" className="inline-flex items-center gap-2 mb-12">
            <div className="w-8 h-8 rounded-lg bg-indigo-500 flex items-center justify-center">
              <Network className="w-5 h-5 text-white" />
            </div>
            <span className="font-semibold text-lg tracking-tight text-white">GraphWeave</span>
          </Link>

          <h1 className="text-3xl font-bold tracking-tight text-white mb-2">Welcome back</h1>
          <p className="text-white/50 mb-8">Sign in to your account to continue building graphs.</p>

          <button
            type="button"
            className="w-full flex items-center justify-center gap-3 px-4 py-3 border border-white/[0.08] rounded-xl text-white hover:bg-white/[0.02] transition-colors mb-6 font-medium"
          >
            <svg viewBox="0 0 24 24" className="w-5 h-5" aria-hidden="true">
              <path d="M12.0003 4.75C13.7703 4.75 15.3553 5.36002 16.6053 6.54998L20.0303 3.125C17.9502 1.19 15.2353 0 12.0003 0C7.31028 0 3.25527 2.69 1.28027 6.60998L5.27028 9.70498C6.21525 6.86002 8.87028 4.75 12.0003 4.75Z" fill="#EA4335" />
              <path d="M23.49 12.275C23.49 11.49 23.415 10.73 23.3 10H12V14.51H18.47C18.18 15.99 17.34 17.25 16.08 18.1L19.945 21.1C22.2 19.01 23.49 15.92 23.49 12.275Z" fill="#4285F4" />
              <path d="M5.26498 14.2949C5.02498 13.5699 4.88501 12.7999 4.88501 11.9999C4.88501 11.1999 5.01998 10.4299 5.26498 9.7049L1.275 6.60986C0.46 8.22986 0 10.0599 0 11.9999C0 13.9399 0.46 15.7699 1.28 17.3899L5.26498 14.2949Z" fill="#FBBC05" />
              <path d="M12.0004 24.0001C15.2404 24.0001 17.9654 22.935 19.9454 21.095L16.0804 18.095C15.0054 18.82 13.6204 19.245 12.0004 19.245C8.8704 19.245 6.21537 17.135 5.26538 14.29L1.27539 17.385C3.25539 21.31 7.3104 24.0001 12.0004 24.0001Z" fill="#34A853" />
            </svg>
            Continue with Google
          </button>

          <div className="flex items-center gap-4 mb-6">
            <div className="flex-1 border-t border-white/[0.08]"></div>
            <span className="text-white/30 text-sm">or sign in with email</span>
            <div className="flex-1 border-t border-white/[0.08]"></div>
          </div>

          {error && (
            <div className="mb-6 p-4 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-white/90">Email address</label>
              <input
                type="email"
                required
                className="w-full px-4 py-3 bg-white/[0.03] border border-white/[0.08] rounded-xl text-white placeholder-white/20 focus:outline-none focus:border-indigo-500 focus:bg-white/[0.05] transition-all"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium text-white/90">Password</label>
              <input
                type="password"
                required
                className="w-full px-4 py-3 bg-white/[0.03] border border-white/[0.08] rounded-xl text-white placeholder-white/20 focus:outline-none focus:border-indigo-500 focus:bg-white/[0.05] transition-all"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full py-3 px-4 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl font-medium transition-colors flex justify-center items-center h-[52px]"
            >
              {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : "Sign in"}
            </button>
          </form>

          <p className="mt-8 text-center text-sm text-white/50">
            Don't have an account?{" "}
            <Link href="/signup" className="text-indigo-400 hover:text-indigo-300 font-medium">
              Create one for free
            </Link>
          </p>
        </div>
      </div>

      {/* Right Visual Side */}
      <div className="hidden lg:flex flex-1 relative bg-indigo-950 overflow-hidden">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-indigo-800/40 via-indigo-950 to-[#0A0A0B]"></div>
        <div className="absolute inset-0 bg-[url('https://grainy-gradients.vercel.app/noise.svg')] opacity-20 mix-blend-overlay"></div>
        <div className="relative z-10 flex flex-col items-center justify-center w-full h-full p-12 text-center">
          <motion.div
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ duration: 1 }}
            className="w-96 h-96 relative"
          >
            {/* Decorative Graph Circles */}
            <div className="absolute inset-0 border border-white/10 rounded-full animate-[spin_60s_linear_infinite]"></div>
            <div className="absolute inset-10 border border-indigo-400/20 rounded-full animate-[spin_40s_linear_infinite_reverse]"></div>
            <div className="absolute inset-20 border border-indigo-500/30 rounded-full border-dashed animate-[spin_20s_linear_infinite]"></div>
            <div className="absolute inset-0 flex items-center justify-center">
              <Network className="w-24 h-24 text-indigo-400 opacity-80" strokeWidth={1} />
            </div>
          </motion.div>
        </div>
      </div>
    </div>
  );
}
