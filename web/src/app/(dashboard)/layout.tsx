"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/browser-client";

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
          <Link href="/" className="dash-wordmark uppercase hover:opacity-80 transition-opacity">
            GRAPHWEAVE
          </Link>
          <nav className="hidden md:flex items-center gap-6">
            {navLinks.map((link) => {
              const isActive = pathname.startsWith(link.href);
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  className={`text-sm font-medium transition-colors ${
                    isActive ? "text-white border-b-2 border-white pb-[2px]" : "text-white/40 hover:text-white/80"
                  }`}
                >
                  {link.label}
                </Link>
              );
            })}
          </nav>
        </div>
        
        <div className="dash-topbar-right">
          <button onClick={handleLogout} className="dash-topbar-link">
            Sign out
          </button>
        </div>
      </header>

      <div className="dash-content">
        {children}
      </div>
    </div>
  );
}
