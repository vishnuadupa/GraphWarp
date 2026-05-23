"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/browser-client";
import { ForceGraph, type GraphData, type ThinkingPhase } from "@/components/ForceGraph";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Send, Filter, Network, ChevronDown } from "lucide-react";

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
  const [filterOpen, setFilterOpen] = useState(false);
  const [thinkingPhase, setThinkingPhase] = useState<ThinkingPhase>(null);
  const [activeNodeIds, setActiveNodeIds] = useState<Set<string>>(new Set());

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) router.replace("/login");
      else {
        setReady(true);
        fetchDocuments();
        fetchFullGraph();
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

  const fetchFullGraph = async () => {
    try {
      const res = await fetch("/api/graph/full");
      if (res.ok) {
        const data = await res.json();
        if (data.graph?.nodes?.length > 0) setGraph(data.graph);
      }
    } catch (err) {
      console.error("Failed to load full graph:", err);
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
    setThinkingPhase("searching");
    setActiveNodeIds(new Set());

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
          const blocks = buffer.split("\n\n");
          buffer = blocks.pop() || "";

          for (const block of blocks) {
            if (block.startsWith("data: ")) {
              const dataStr = block.slice(6);
              if (dataStr === "[DONE]") continue;
              try {
                const parsed = JSON.parse(dataStr);

                if (parsed.type === "phase") {
                  setThinkingPhase(parsed.data as ThinkingPhase);

                } else if (parsed.type === "graph") {
                  setGraph(parsed.data);
                  if (parsed.activeNodeIds?.length > 0) {
                    setActiveNodeIds(new Set<string>(parsed.activeNodeIds));
                  }

                } else if (parsed.type === "text") {
                  assistantMessage += parsed.data;

                  let displayContent = assistantMessage;
                  let suggestions: string[] = [];
                  const suggestionMatch = assistantMessage.match(
                    /<suggestions>([\s\S]*?)<\/suggestions>/
                  );
                  if (suggestionMatch) {
                    displayContent = assistantMessage.replace(suggestionMatch[0], "").trim();
                    try {
                      suggestions = JSON.parse(suggestionMatch[1]);
                    } catch (e) {}
                  }

                  setMessages((prev) => {
                    const newMessages = [...prev];
                    const lastMsg = newMessages[newMessages.length - 1];
                    lastMsg.content = displayContent;
                    if (suggestions.length > 0) lastMsg.suggestions = suggestions;
                    return newMessages;
                  });

                } else if (parsed.type === "error") {
                  throw new Error(parsed.data);
                }
              } catch (e) {
                // ignore partial JSON
              }
            }
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last && last.role === "assistant" && last.content === "") {
          const newMessages = [...prev];
          newMessages[newMessages.length - 1].content = `Error: ${msg}`;
          return newMessages;
        }
        return [...prev, { role: "assistant", content: `Error: ${msg}` }];
      });
    } finally {
      setLoading(false);
      setThinkingPhase(null);
      // Fade out active highlights after 3 s
      setTimeout(() => setActiveNodeIds(new Set()), 3000);
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
        setGraph((prev) => {
          const newNodes = [...prev.nodes];
          const newLinks = [...prev.links];
          const nodeMap = new Set(newNodes.map((n) => n.id));

          data.graph.nodes.forEach((n: any) => {
            if (!nodeMap.has(n.id)) {
              newNodes.push(n);
              nodeMap.add(n.id);
            }
          });

          data.graph.links.forEach((l: any) => {
            const sId = typeof l.source === "object" ? l.source.id : l.source;
            const tId = typeof l.target === "object" ? l.target.id : l.target;
            const exists = newLinks.some((ex: any) => {
              const exsId = typeof ex.source === "object" ? ex.source.id : ex.source;
              const extId = typeof ex.target === "object" ? ex.target.id : ex.target;
              return exsId === sId && extId === tId && ex.label === l.label;
            });
            if (!exists) newLinks.push(l);
          });
          return { nodes: newNodes, links: newLinks };
        });
      }
    } catch (err) {
      console.error("Failed to expand graph", err);
    }
  }, []);

  const toggleDocSelection = (filename: string) => {
    setSelectedDocs((prev) =>
      prev.includes(filename)
        ? prev.filter((d) => d !== filename)
        : [...prev, filename]
    );
  };

  if (!ready) return null;

  return (
    <div className="chat-layout h-full">

      {/* Left Chat Panel */}
      <section className="chat-panel">

        {/* Chat Header */}
        <div className="h-16 flex items-center justify-between px-6 border-b border-[var(--color-rule)] bg-[var(--color-paper)]">
          <h2 className="font-medium text-[var(--color-ink)] flex items-center gap-2">
            Semantic Graph Chat
          </h2>
          {availableDocs.length > 0 && (
            <div className="relative">
              <button
                onClick={() => setFilterOpen(!filterOpen)}
                className="flex items-center gap-2 px-3 py-1.5 rounded-sm bg-[var(--color-paper)] hover:bg-[var(--color-paper-2)] border border-[var(--color-rule)] text-sm text-[var(--color-ink)] transition-colors"
              >
                <Filter className="w-3.5 h-3.5" />
                {selectedDocs.length === 0 ? "All Docs" : `${selectedDocs.length} Selected`}
                <ChevronDown className="w-3.5 h-3.5 opacity-50" />
              </button>

              {filterOpen && (
                <div className="absolute right-0 top-full mt-2 w-64 rounded-sm bg-[var(--color-paper)] border border-[var(--color-rule)] shadow-lg z-50 overflow-hidden">
                  <div className="p-2 border-b border-[var(--color-rule)]">
                    <label className="flex items-center gap-3 px-3 py-2 hover:bg-[var(--color-paper-2)] rounded-sm cursor-pointer transition-colors">
                      <input
                        type="checkbox"
                        className="rounded-sm border-[var(--color-rule)] bg-transparent text-[var(--color-ink)] focus:ring-[var(--color-ink)]"
                        checked={selectedDocs.length === 0}
                        onChange={() => setSelectedDocs([])}
                      />
                      <span className="text-sm text-[var(--color-ink)]">All Documents</span>
                    </label>
                  </div>
                  <div className="p-2 max-h-60 overflow-y-auto">
                    {availableDocs.map((doc) => (
                      <label key={doc.id} className="flex items-center gap-3 px-3 py-2 hover:bg-[var(--color-paper-2)] rounded-sm cursor-pointer transition-colors">
                        <input
                          type="checkbox"
                          className="rounded-sm border-[var(--color-rule)] bg-transparent text-[var(--color-ink)] focus:ring-[var(--color-ink)]"
                          checked={selectedDocs.includes(doc.filename)}
                          onChange={() => toggleDocSelection(doc.filename)}
                        />
                        <span className="text-sm text-[var(--color-neutral)] truncate">{doc.filename}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Chat Messages */}
        <div className="chat-messages">
          {messages.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center opacity-40">
              <Network className="w-12 h-12 mb-4 text-[var(--color-ink)]" />
              <p className="text-center text-sm uppercase tracking-widest font-bold text-[var(--color-ink)]">
                Zero-Hallucination<br />Graph Context
              </p>
            </div>
          ) : (
            messages.map((m, i) => (
              <div
                key={i}
                className={`flex flex-col ${m.role === "user" ? "items-end" : "items-start"}`}
              >
                <div className={`chat-msg ${m.role === "user" ? "chat-msg--user" : "chat-msg--assistant"}`}>
                  {m.role === "user" ? (
                    m.content
                  ) : (
                    <div className="prose prose-sm max-w-none text-[var(--color-ink)]">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                    </div>
                  )}
                </div>

                {m.role === "assistant" && m.suggestions && m.suggestions.length > 0 && (
                  <div className="flex flex-wrap gap-2 mt-3 ml-2">
                    {m.suggestions.map((sug, idx) => (
                      <button
                        key={idx}
                        onClick={() => handleSend(sug)}
                        disabled={loading}
                        className="px-3 py-1.5 rounded-sm bg-[var(--color-paper)] hover:bg-[var(--color-paper-2)] border border-[var(--color-rule)] text-[var(--color-ink)] text-xs font-medium transition-colors"
                      >
                        {sug}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))
          )}

          {loading && messages[messages.length - 1]?.role !== "assistant" && (
            <div className="flex items-center gap-3 text-[var(--color-neutral)] text-sm font-medium px-2">
              <div className="flex gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-neutral)] animate-bounce" />
                <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-neutral)] animate-bounce" style={{ animationDelay: "150ms" }} />
                <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-neutral)] animate-bounce" style={{ animationDelay: "300ms" }} />
              </div>
              {thinkingPhase === "searching"  && "Resolving entities…"}
              {thinkingPhase === "traversing" && "Traversing graph…"}
              {thinkingPhase === "answering"  && "Synthesising answer…"}
              {!thinkingPhase                 && "Thinking…"}
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Input Area */}
        <div className="p-4 border-t border-[var(--color-rule)] bg-[var(--color-paper)]">
          <div className="relative flex items-end gap-2 bg-[var(--color-paper)] border border-[var(--color-rule)] focus-within:border-[var(--color-ink)] rounded-md transition-colors p-2">
            <textarea
              ref={textareaRef}
              className="flex-1 max-h-40 min-h-[44px] bg-transparent text-sm text-[var(--color-ink)] placeholder-[var(--color-neutral)] resize-none outline-none py-3 px-3 leading-relaxed"
              placeholder="Ask about your documents…"
              rows={1}
              value={input}
              onChange={handleTextareaInput}
              onKeyDown={handleKeyDown}
              disabled={loading}
            />
            <button
              onClick={() => handleSend()}
              disabled={!input.trim() || loading}
              className="shrink-0 w-10 h-10 rounded-sm bg-[var(--color-ink)] hover:opacity-80 disabled:opacity-30 text-[var(--color-paper)] flex items-center justify-center transition-all mb-0.5"
            >
              <Send className="w-4 h-4" />
            </button>
          </div>
        </div>
      </section>

      {/* Right Graph Panel */}
      <section className="hidden md:flex flex-1 flex-col bg-[var(--color-surface-dark)] relative overflow-hidden">
        <ForceGraph
          data={graph}
          thinkingPhase={thinkingPhase}
          activeNodeIds={activeNodeIds}
          onNodeClick={handleNodeClick}
        />
      </section>
    </div>
  );
}
