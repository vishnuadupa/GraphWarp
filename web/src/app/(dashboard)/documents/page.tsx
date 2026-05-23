"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/browser-client";

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
    <div className="dash-shell">
      <header className="dash-topbar">
        <Link href="/" className="dash-wordmark">GraphWeave</Link>
        <nav className="dash-topbar-right">
          <Link href="/chat" className="dash-topbar-link">Chat</Link>
          <Link href="/upload" className="dash-topbar-link">Upload</Link>
          <Link href="/documents" className="dash-topbar-link">My Documents</Link>
        </nav>
      </header>

      <main className="dash-content" style={{ padding: 'var(--space-2xl)' }}>
        <div style={{ maxWidth: '800px', margin: '0 auto', width: '100%' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-xl)' }}>
            <h1 style={{ fontSize: '1.5rem', color: 'var(--gray-900)' }}>My Documents</h1>
            <Link href="/upload" style={{
              background: 'var(--primary-600)',
              color: 'white',
              padding: '0.5rem 1rem',
              borderRadius: '6px',
              textDecoration: 'none',
              fontSize: '0.875rem'
            }}>
              Upload New
            </Link>
          </div>

          {loading ? (
            <div style={{ color: 'var(--gray-500)' }}>Loading documents...</div>
          ) : documents.length === 0 ? (
            <div className="empty-state" style={{ 
              textAlign: 'center', 
              padding: 'var(--space-3xl)', 
              background: 'white', 
              borderRadius: '8px',
              border: '1px solid var(--gray-200)'
            }}>
              <p style={{ color: 'var(--gray-500)', marginBottom: 'var(--space-md)' }}>No documents found.</p>
              <Link href="/upload" style={{ color: 'var(--primary-600)' }}>Upload your first document</Link>
            </div>
          ) : (
            <div style={{ background: 'white', borderRadius: '8px', border: '1px solid var(--gray-200)', overflow: 'hidden' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
                <thead style={{ background: 'var(--gray-50)', borderBottom: '1px solid var(--gray-200)' }}>
                  <tr>
                    <th style={{ padding: '1rem', fontWeight: 500, color: 'var(--gray-600)' }}>Filename</th>
                    <th style={{ padding: '1rem', fontWeight: 500, color: 'var(--gray-600)' }}>Status</th>
                    <th style={{ padding: '1rem', fontWeight: 500, color: 'var(--gray-600)' }}>Uploaded</th>
                    <th style={{ padding: '1rem', fontWeight: 500, color: 'var(--gray-600)', textAlign: 'right' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {documents.map((doc) => (
                    <tr key={doc.id} style={{ borderBottom: '1px solid var(--gray-100)' }}>
                      <td style={{ padding: '1rem', color: 'var(--gray-900)' }}>{doc.filename}</td>
                      <td style={{ padding: '1rem' }}>
                        <span style={{
                          display: 'inline-block',
                          padding: '0.25rem 0.5rem',
                          borderRadius: '9999px',
                          fontSize: '0.75rem',
                          fontWeight: 500,
                          background: doc.status === 'Completed' ? '#dcfce7' : '#fef9c3',
                          color: doc.status === 'Completed' ? '#166534' : '#854d0e'
                        }}>
                          {doc.status}
                        </span>
                      </td>
                      <td style={{ padding: '1rem', color: 'var(--gray-500)', fontSize: '0.875rem' }}>
                        {new Date(doc.created_at).toLocaleDateString()}
                      </td>
                      <td style={{ padding: '1rem', textAlign: 'right' }}>
                        <button
                          onClick={() => handleDelete(doc.id)}
                          style={{
                            background: 'transparent',
                            color: '#ef4444',
                            border: 'none',
                            cursor: 'pointer',
                            fontSize: '0.875rem',
                            fontWeight: 500
                          }}
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
