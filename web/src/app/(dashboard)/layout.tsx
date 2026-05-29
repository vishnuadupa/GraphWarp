"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/browser-client";
import { ThemeToggle } from "@/components/ThemeToggle";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();

  const handleLogout = async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
  };

  const navLinks = [
    { href: "/upload", label: "Ingest" },
    { href: "/chat", label: "Graph Chat" },
    { href: "/documents", label: "Documents" },
  ];

  return (
    <div className="dash-shell">
      <header className="dash-topbar">
        <div className="flex items-center gap-8">
          <Link href="/chat" className="dash-wordmark uppercase hover:opacity-80 transition-opacity">
            GRAPHWARP
          </Link>
          <nav className="hidden md:flex items-center gap-6">
            {navLinks.map((link) => {
              const isActive = pathname.startsWith(link.href);
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  className={`text-xs font-mono uppercase tracking-widest font-bold transition-all ${
                    isActive ? "text-[var(--color-ink)] border-b-[2px] border-[var(--color-ink)] pb-[2px]" : "text-[var(--color-neutral)] hover:text-[var(--color-ink)]"
                  }`}
                >
                  {link.label}
                </Link>
              );
            })}
          </nav>
        </div>
        
        <div className="dash-topbar-right flex items-center gap-4">
          <ThemeToggle />
          <button onClick={handleLogout} className="dash-topbar-link">
            Sign out
          </button>
        </div>
      </header>

      <div className="dash-content pb-20 md:pb-0">
        {children}
      </div>

      {/* Floating Mobile Tab Rail */}
      <div className="fixed bottom-4 left-4 right-4 z-50 md:hidden bg-[var(--color-paper)] border-[2px] border-[var(--color-rule)] shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]">
        <nav className="flex justify-around items-center h-12">
          {navLinks.map((link) => {
            const isActive = pathname.startsWith(link.href);
            return (
              <Link
                key={link.href}
                href={link.href}
                className={`flex-1 text-center text-[10px] font-mono uppercase font-bold tracking-wider h-full flex items-center justify-center transition-all border-r-[2px] last:border-r-0 border-[var(--color-rule)] ${
                  isActive
                    ? "bg-[var(--color-ink)] text-[var(--color-paper)]"
                    : "text-[var(--color-neutral)] hover:bg-[var(--color-paper-2)] hover:text-[var(--color-ink)]"
                }`}
              >
                {link.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </div>
  );
}
