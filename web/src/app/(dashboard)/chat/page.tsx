"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/browser-client";
import { ForceGraph, type GraphData } from "@/components/ForceGraph";

interface Message {
  role: "user" | "assistant";
  content: string;
}

const EMPTY_GRAPH: GraphData = { nodes: [], links: [] };

export default function ChatPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [graph, setGraph] = useState<GraphData>(EMPTY_GRAPH);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) router.replace("/login");
      else setReady(true);
    });
  }, [router]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSend = async () => {
    const text = input.trim();
    if (!text || loading) return;

    const userMessage: Message = { role: "user", content: text };
    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setLoading(true);

    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          history: messages,
        }),
      });

      if (!res.ok) throw new Error(`API ${res.status}`);

      const data = await res.json();
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: data.answer ?? "(no response)" },
      ]);
      if (data.graph) setGraph(data.graph);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: `Could not reach /api/chat — ${msg}. The backend may not be wired yet.`,
        },
      ]);
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleTextareaInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    const el = e.target;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  };

  if (!ready) return null;

  return (
    <div className="dash-shell">
      <header className="dash-topbar">
        <Link href="/" className="dash-wordmark">GraphRAG</Link>
        <nav className="dash-topbar-right">
          <Link href="/upload" className="dash-topbar-link">Upload</Link>
          <LogoutButton router={router} />
        </nav>
      </header>

      <main className="dash-content">
        {/* Left: chat panel */}
        <section className="chat-panel" aria-label="Chat">
          <div className="chat-messages" role="log" aria-live="polite">
            {messages.length === 0 ? (
              <div className="chat-empty">
                ASK ANYTHING ABOUT<br />YOUR DOCUMENTS
              </div>
            ) : (
              messages.map((m, i) => (
                <div
                  key={i}
                  className={`chat-msg chat-msg--${m.role}`}
                >
                  {m.content}
                </div>
              ))
            )}
            {loading && (
              <div className="chat-msg chat-msg--thinking">traversing graph…</div>
            )}
            <div ref={messagesEndRef} />
          </div>

          <div className="chat-input-area">
            <textarea
              ref={textareaRef}
              className="chat-textarea"
              placeholder="Ask about your documents…"
              rows={1}
              value={input}
              onChange={handleTextareaInput}
              onKeyDown={handleKeyDown}
              disabled={loading}
              aria-label="Chat input"
            />
            <button
              className="chat-send"
              onClick={handleSend}
              disabled={!input.trim() || loading}
              aria-label="Send message"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="22" y1="2" x2="11" y2="13" />
                <polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>
            </button>
          </div>
        </section>

        {/* Right: graph panel */}
        <section className="graph-panel" aria-label="Knowledge graph">
          <ForceGraph data={graph} />
          <div className="graph-label" style={{
            position: "absolute",
            top: "var(--space-md)",
            left: "var(--space-md)",
            pointerEvents: "none",
          }}>
            KNOWLEDGE GRAPH
          </div>
        </section>
      </main>
    </div>
  );
}

function LogoutButton({ router }: { router: ReturnType<typeof useRouter> }) {
  const handleLogout = async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.replace("/login");
    router.refresh();
  };

  return (
    <button
      onClick={handleLogout}
      className="dash-topbar-link"
      style={{ background: "none", border: "none", cursor: "pointer", padding: 0 }}
    >
      Sign out
    </button>
  );
}
