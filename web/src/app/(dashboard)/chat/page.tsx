"use client";

import { useEffect, useRef, useState, useCallback } from "react";
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
        body: JSON.stringify({ question: text }),
      });

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || `API ${res.status}`);
      }
      if (!res.body) throw new Error("No response body");

      setMessages((prev) => [...prev, { role: "assistant", content: "" }]);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let done = false;
      let assistantMessage = "";
      let buffer = "";

      while (!done) {
        const { value, done: readerDone } = await reader.read();
        done = readerDone;
        if (value) {
          buffer += decoder.decode(value, { stream: true });
          const blocks = buffer.split('\\n\\n');
          buffer = blocks.pop() || "";
          
          for (const block of blocks) {
            if (block.startsWith('data: ')) {
              const dataStr = block.slice(6);
              if (dataStr === '[DONE]') continue;
              try {
                const parsed = JSON.parse(dataStr);
                if (parsed.type === 'graph') {
                  setGraph(parsed.data);
                } else if (parsed.type === 'text') {
                  assistantMessage += parsed.data;
                  setMessages((prev) => {
                    const newMessages = [...prev];
                    newMessages[newMessages.length - 1].content = assistantMessage;
                    return newMessages;
                  });
                } else if (parsed.type === 'error') {
                  throw new Error(parsed.data);
                }
              } catch (e) {
                // Ignore partial JSON parse errors just in case
              }
            }
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last && last.role === 'assistant' && last.content === '') {
          const newMessages = [...prev];
          newMessages[newMessages.length - 1].content = `Error: ${msg}`;
          return newMessages;
        } else {
          return [...prev, { role: "assistant", content: `Error: ${msg}` }];
        }
      });
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

  const handleNodeClick = useCallback(async (node: any) => {
    try {
      const res = await fetch("/api/graph/expand", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nodeId: node.id }),
      });
      if (res.ok) {
        const data = await res.json();
        setGraph(prev => {
          const newNodes = [...prev.nodes];
          const newLinks = [...prev.links];
          
          const nodeMap = new Set(newNodes.map(n => n.id));
          data.graph.nodes.forEach((n: any) => {
            if (!nodeMap.has(n.id)) {
              newNodes.push(n);
              nodeMap.add(n.id);
            }
          });

          data.graph.links.forEach((l: any) => {
            const sId = typeof l.source === 'object' ? l.source.id : l.source;
            const tId = typeof l.target === 'object' ? l.target.id : l.target;
            const exists = newLinks.some((ex: any) => {
               const exsId = typeof ex.source === 'object' ? ex.source.id : ex.source;
               const extId = typeof ex.target === 'object' ? ex.target.id : ex.target;
               return exsId === sId && extId === tId && ex.label === l.label;
            });
            if (!exists) newLinks.push(l);
          });
          return { nodes: newNodes, links: newLinks };
        });
      }
    } catch(err) {
      console.error("Failed to expand graph", err);
    }
  }, []);

  if (!ready) return null;

  return (
    <div className="dash-shell">
      <header className="dash-topbar">
        <Link href="/" className="dash-wordmark">GraphWeave</Link>
        <nav className="dash-topbar-right">
          <Link href="/upload" className="dash-topbar-link">Upload</Link>
          <Link href="/documents" className="dash-topbar-link">My Documents</Link>
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
                  className={\`chat-msg chat-msg--\${m.role}\`}
                >
                  {m.content}
                </div>
              ))
            )}
            {loading && messages[messages.length - 1]?.role !== 'assistant' && (
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
          <ForceGraph data={graph} onNodeClick={handleNodeClick} />
          <div className="graph-label" style={{
            position: "absolute",
            top: "var(--space-md)",
            left: "var(--space-md)",
            pointerEvents: "none",
          }}>
            KNOWLEDGE GRAPH
            <br />
            <small style={{ opacity: 0.6 }}>Double-click nodes to expand</small>
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
