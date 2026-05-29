import type { Metadata } from "next";
import { Geist, Geist_Mono, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { GlobalDropzone } from "@/components/GlobalDropzone";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
  weight: ["400", "700"],
});

export const metadata: Metadata = {
  title: "GraphWarp | Personal GraphRAG Engine",
  description:
    "Transform your documents into an intelligent knowledge graph. Ask questions, discover connections, and surface insights that flat search misses.",
  keywords: ["knowledge graph", "RAG", "GraphRAG", "Neo4j", "AI", "document intelligence", "GraphWarp"],
  openGraph: {
    title: "GraphWarp | Personal GraphRAG Engine",
    description: "Transform your documents into an intelligent knowledge graph.",
    type: "website",
  },
};

import { ThemeProvider } from "@/components/ThemeProvider";

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} ${jetbrainsMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-background text-foreground transition-colors duration-300">
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
          <GlobalDropzone>
            {children}
          </GlobalDropzone>
        </ThemeProvider>
      </body>
    </html>
  );
}
