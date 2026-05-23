"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/browser-client";
import { ForceGraph, type GraphData } from "@/components/ForceGraph";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface Message {
  role: "user" | "assistant";
  content: string;
  suggestions?: string[];
}

const EMPTY_GRAPH: GraphData = { nodes: [], links: [] };

export default function ChatPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [graph, setGraph] = useState<GraphData>(EMPTY_GRAPH);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [availableDocs, setAvailableDocs] = useState<any[]>([]);
  const [selectedDocs, setSelectedDocs] = useState<string[]>([]);
  
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) router.replace("/login");
      else {
        setReady(true);
        fetchDocuments();
      }
    });
  }, [router]);

  const fetchDocuments = async () => {
    try {
      const res = await fetch("/api/documents");
      if (res.ok) {
        const data = await res.json();
        setAvailableDocs(data.documents || []);
      }
    } catch (err) {
      console.error(err);
    }
  };

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSend = async (textOverride?: string) => {
    const text = textOverride || input.trim();
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
        body: JSON.stringify({ question: text, selectedDocs }),
      });

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || `API \${res.status}`);
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
          const blocks = buffer.split('\n\n');
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
                  
                  // Extract <suggestions> block
                  let displayContent = assistantMessage;
                  let suggestions: string[] = [];
                  const suggestionMatch = assistantMessage.match(/<suggestions>([\s\S]*?)<\/suggestions>/);
                  if (suggestionMatch) {
                     displayContent = assistantMessage.replace(suggestionMatch[0], '').trim();
                     try {
                       suggestions = JSON.parse(suggestionMatch[1]);
                     } catch(e) {}
                  }

                  setMessages((prev) => {
                    const newMessages = [...prev];
                    const lastMsg = newMessages[newMessages.length - 1];
                    lastMsg.content = displayContent;
                    if (suggestions.length > 0) {
                      lastMsg.suggestions = suggestions;
                    }
                    return newMessages;
                  });
                } else if (parsed.type === 'error') {
                  throw new Error(parsed.data);
                }
              } catch (e) {
                // Ignore partial JSON parse errors
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
          newMessages[newMessages.length - 1].content = `Error: \${msg}`;
          return newMessages;
        } else {
          return [...prev, { role: "assistant", content: `Error: \${msg}` }];
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
    el.style.height = `\${Math.min(el.scrollHeight, 160)}px`;
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

  const toggleDocSelection = (filename: string) => {
    setSelectedDocs(prev => 
      prev.includes(filename) 
        ? prev.filter(d => d !== filename)
        : [...prev, filename]
    );
  };

  if (!ready) return null;

  return (
    <div className="dash-shell">
      <header className="dash-topbar">
        <Link href="/" className="dash-wordmark">GraphWeave</Link>
        <div style={{display: 'flex', alignItems: 'center', gap: '1rem'}}>
          {availableDocs.length > 0 && (
            <div className="doc-selector" style={{position: 'relative'}}>
              <button 
                style={{
                  background: 'var(--gray-100)', 
                  border: '1px solid var(--gray-200)',
                  padding: '4px 12px',
                  borderRadius: '16px',
                  fontSize: '12px',
                  cursor: 'pointer'
                }}
                onClick={(e) => {
                  const menu = e.currentTarget.nextElementSibling as HTMLElement;
                  menu.style.display = menu.style.display === 'block' ? 'none' : 'block';
                }}
              >
                Filters: {selectedDocs.length === 0 ? "All Docs" : `\${selectedDocs.length} Selected`} ▾
              </button>
              <div 
                className="doc-menu"
                style={{
                  display: 'none', position: 'absolute', top: '100%', right: 0, marginTop: '8px',
                  background: 'white', border: '1px solid var(--gray-200)', borderRadius: '8px',
                  boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)', zIndex: 50, padding: '8px',
                  minWidth: '200px', maxHeight: '300px', overflowY: 'auto'
                }}
              >
                <label style={{display: 'flex', alignItems: 'center', gap: '8px', padding: '4px', fontSize: '14px', cursor: 'pointer'}}>
                  <input type="checkbox" checked={selectedDocs.length === 0} onChange={() => setSelectedDocs([])} />
                  All Documents
                </label>
                <hr style={{margin: '4px 0', borderColor: 'var(--gray-100)'}} />
                {availableDocs.map(doc => (
                  <label key={doc.id} style={{display: 'flex', alignItems: 'center', gap: '8px', padding: '4px', fontSize: '14px', cursor: 'pointer'}}>
                    <input 
                      type="checkbox" 
                      checked={selectedDocs.includes(doc.filename)}
                      onChange={() => toggleDocSelection(doc.filename)}
                    />
                    {doc.filename}
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>
        <nav className="dash-topbar-right">
          <Link href="/upload" className="dash-topbar-link">Upload</Link>
          <Link href="/documents" className="dash-topbar-link">My Documents</Link>
          <LogoutButton router={router} />
        </nav>
      </header>

      <main className="dash-content">
        <section className="chat-panel" aria-label="Chat">
          <div className="chat-messages" role="log" aria-live="polite">
            {messages.length === 0 ? (
              <div className="chat-empty">
                ASK ANYTHING ABOUT<br />YOUR DOCUMENTS
              </div>
            ) : (
              messages.map((m, i) => (
                <div key={i} style={{ display: 'flex', flexDirection: 'column' }}>
                  <div className={`chat-msg chat-msg--\${m.role}`}>
                    {m.role === 'user' ? (
                       m.content 
                    ) : (
                       <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                    )}
                  </div>
                  {m.role === 'assistant' && m.suggestions && m.suggestions.length > 0 && (
                    <div className="chat-suggestions" style={{display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '8px', marginBottom: '16px'}}>
                      {m.suggestions.map((sug, idx) => (
                        <button 
                          key={idx} 
                          onClick={() => handleSend(sug)}
                          disabled={loading}
                          style={{
                            background: 'var(--gray-50)', border: '1px solid var(--gray-200)',
                            borderRadius: '16px', padding: '6px 12px', fontSize: '12px',
                            color: 'var(--gray-600)', cursor: 'pointer', transition: 'all 0.2s'
                          }}
                          onMouseOver={(e) => { e.currentTarget.style.background = 'var(--gray-100)'; e.currentTarget.style.color = 'var(--gray-900)'; }}
                          onMouseOut={(e) => { e.currentTarget.style.background = 'var(--gray-50)'; e.currentTarget.style.color = 'var(--gray-600)'; }}
                        >
                          {sug}
                        </button>
                      ))}
                    </div>
                  )}
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
              onClick={() => handleSend()}
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

        <section className="graph-panel" aria-label="Knowledge graph">
          <ForceGraph data={graph} onNodeClick={handleNodeClick} />
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
