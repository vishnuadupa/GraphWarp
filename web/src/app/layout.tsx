import type { Metadata } from "next";
import { Inter, Outfit, Geist_Mono } from "next/font/google";
import "./globals.css";
import { GlobalDropzone } from "@/components/GlobalDropzone";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const outfit = Outfit({
  variable: "--font-outfit",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700", "800"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
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

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${outfit.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <GlobalDropzone>
          {children}
        </GlobalDropzone>
      </body>
    </html>
  );
}
