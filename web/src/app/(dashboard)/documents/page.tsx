"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/browser-client";
import { motion } from "framer-motion";
import { FileText, Loader2, Trash2, Upload, Plus } from "lucide-react";

export default function DocumentsPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [documents, setDocuments] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) {
        router.replace("/login");
      } else {
        setReady(true);
        fetchDocuments();
      }
    });
  }, [router]);

  const fetchDocuments = async () => {
    try {
      setLoading(true);
      const res = await fetch("/api/documents");
      if (res.ok) {
        const data = await res.json();
        setDocuments(data.documents || []);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Are you sure? This will remove the document and its graph data.")) return;
    try {
      const res = await fetch("/api/documents", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentId: id }),
      });
      if (res.ok) {
        setDocuments((prev) => prev.filter((d) => d.id !== id));
      } else {
        alert("Failed to delete document.");
      }
    } catch (err) {
      console.error(err);
      alert("Error deleting document.");
    }
  };

  if (!ready) return null;

  return (
    <div className="flex-1 overflow-y-auto p-8 lg:p-12">
      <div className="max-w-5xl mx-auto space-y-8">
        <div className="flex justify-between items-end border-b border-white/[0.08] pb-6">
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="space-y-2"
          >
            <h1 className="text-3xl font-bold tracking-tight">Documents</h1>
            <p className="text-white/50">Manage your ingested knowledge base files.</p>
          </motion.div>
          
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
          >
            <Link
              href="/upload"
              className="flex items-center gap-2 px-4 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl font-medium transition-all"
            >
              <Plus className="w-4 h-4" />
              Add Document
            </Link>
          </motion.div>
        </div>

        {loading ? (
          <div className="flex justify-center py-20">
            <Loader2 className="w-8 h-8 animate-spin text-indigo-500" />
          </div>
        ) : documents.length === 0 ? (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex flex-col items-center justify-center py-24 px-6 rounded-3xl border border-white/[0.08] border-dashed bg-white/[0.01]"
          >
            <div className="w-16 h-16 rounded-2xl bg-indigo-500/10 text-indigo-400 flex items-center justify-center mb-6">
              <FileText className="w-8 h-8" />
            </div>
            <h3 className="text-xl font-semibold mb-2">No documents yet</h3>
            <p className="text-white/50 text-center max-w-sm mb-8">
              Upload your first document to begin building your deterministic knowledge graph.
            </p>
            <Link
              href="/upload"
              className="flex items-center gap-2 px-6 py-3 bg-white text-black hover:bg-white/90 rounded-xl font-medium transition-all"
            >
              <Upload className="w-4 h-4" />
              Upload Document
            </Link>
          </motion.div>
        ) : (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="rounded-2xl border border-white/[0.08] bg-white/[0.02] overflow-hidden"
          >
            <table className="w-full text-left">
              <thead className="bg-white/[0.02] border-b border-white/[0.08]">
                <tr>
                  <th className="px-6 py-4 text-sm font-medium text-white/50">Filename</th>
                  <th className="px-6 py-4 text-sm font-medium text-white/50">Status</th>
                  <th className="px-6 py-4 text-sm font-medium text-white/50">Uploaded</th>
                  <th className="px-6 py-4 text-sm font-medium text-white/50 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.08]">
                {documents.map((doc) => (
                  <tr key={doc.id} className="hover:bg-white/[0.02] transition-colors">
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-3">
                        <FileText className="w-5 h-5 text-indigo-400" />
                        <span className="font-medium text-white/90">{doc.filename}</span>
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium ${
                        doc.status === 'Completed' 
                          ? 'bg-green-500/10 text-green-400 border border-green-500/20' 
                          : 'bg-yellow-500/10 text-yellow-400 border border-yellow-500/20'
                      }`}>
                        {doc.status}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-sm text-white/50">
                      {new Date(doc.created_at).toLocaleDateString()}
                    </td>
                    <td className="px-6 py-4 text-right">
                      <button
                        onClick={() => handleDelete(doc.id)}
                        className="inline-flex items-center justify-center w-8 h-8 rounded-lg text-white/30 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </motion.div>
        )}
      </div>
    </div>
  );
}
