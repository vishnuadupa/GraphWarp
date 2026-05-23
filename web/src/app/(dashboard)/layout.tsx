"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { createClient } from "@/lib/supabase/browser-client";
import { useRouter } from "next/navigation";
import { Network, Upload, FileText, MessageSquare, LogOut } from "lucide-react";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();

  const handleLogout = async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
  };

  const navLinks = [
    { href: "/upload", label: "Ingest", icon: <Upload className="w-5 h-5" /> },
    { href: "/chat", label: "Graph Chat", icon: <MessageSquare className="w-5 h-5" /> },
    { href: "/documents", label: "Documents", icon: <FileText className="w-5 h-5" /> },
  ];

  return (
    <div className="flex h-screen bg-[#0A0A0B] text-white overflow-hidden">
      {/* Sidebar */}
      <aside className="w-64 border-r border-white/[0.08] bg-white/[0.02] flex flex-col hidden md:flex shrink-0">
        <div className="h-16 flex items-center px-6 border-b border-white/[0.08]">
          <Link href="/" className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-indigo-500 flex items-center justify-center">
              <Network className="w-5 h-5 text-white" />
            </div>
            <span className="font-semibold text-lg tracking-tight">GraphWeave</span>
          </Link>
        </div>

        <nav className="flex-1 px-4 py-6 space-y-2 overflow-y-auto">
          {navLinks.map((link) => {
            const isActive = pathname.startsWith(link.href);
            return (
              <Link
                key={link.href}
                href={link.href}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all ${
                  isActive
                    ? "bg-indigo-500/10 text-indigo-400 border border-indigo-500/20"
                    : "text-white/60 hover:text-white hover:bg-white/[0.04] border border-transparent"
                }`}
              >
                {link.icon}
                {link.label}
              </Link>
            );
          })}
        </nav>

        <div className="p-4 border-t border-white/[0.08]">
          <button
            onClick={handleLogout}
            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium text-white/60 hover:text-white hover:bg-white/[0.04] transition-all"
          >
            <LogOut className="w-5 h-5" />
            Sign out
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col min-w-0 overflow-hidden relative">
        {children}
      </main>
    </div>
  );
}
