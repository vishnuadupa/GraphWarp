"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/browser-client";
import { ForceGraph, type GraphData } from "@/components/ForceGraph";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { motion } from "framer-motion";
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
                 // ignore partial json
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

  const toggleDocSelection = (filename: string) => {
    setSelectedDocs(prev => 
      prev.includes(filename) 
        ? prev.filter(d => d !== filename)
        : [...prev, filename]
    );
  };

  if (!ready) return null;

  return (
    <div className="flex-1 flex flex-col md:flex-row h-full overflow-hidden bg-[#0A0A0B]">
      
      {/* Left Chat Panel */}
      <section className="flex-1 flex flex-col min-w-[320px] max-w-2xl border-r border-white/[0.08] relative">
        
        {/* Chat Header w/ Filters */}
        <div className="h-16 flex items-center justify-between px-6 border-b border-white/[0.08] bg-white/[0.01]">
          <h2 className="font-medium text-white/90 flex items-center gap-2">
            Semantic Graph Chat
          </h2>
          {availableDocs.length > 0 && (
            <div className="relative">
              <button 
                onClick={() => setFilterOpen(!filterOpen)}
                className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] border border-white/[0.08] text-sm text-white/80 transition-colors"
              >
                <Filter className="w-3.5 h-3.5" />
                {selectedDocs.length === 0 ? "All Docs" : `${selectedDocs.length} Selected`}
                <ChevronDown className="w-3.5 h-3.5 opacity-50" />
              </button>
              
              {filterOpen && (
                <div className="absolute right-0 top-full mt-2 w-64 rounded-xl bg-[#111113] border border-white/[0.08] shadow-xl z-50 overflow-hidden">
                  <div className="p-2 border-b border-white/[0.08]">
                     <label className="flex items-center gap-3 px-3 py-2 hover:bg-white/[0.04] rounded-lg cursor-pointer transition-colors">
                       <input 
                         type="checkbox" 
                         className="rounded border-white/20 bg-transparent text-indigo-500 focus:ring-indigo-500/20"
                         checked={selectedDocs.length === 0} 
                         onChange={() => setSelectedDocs([])} 
                       />
                       <span className="text-sm text-white/90">All Documents</span>
                     </label>
                  </div>
                  <div className="p-2 max-h-60 overflow-y-auto">
                    {availableDocs.map(doc => (
                      <label key={doc.id} className="flex items-center gap-3 px-3 py-2 hover:bg-white/[0.04] rounded-lg cursor-pointer transition-colors">
                        <input 
                          type="checkbox"
                          className="rounded border-white/20 bg-transparent text-indigo-500 focus:ring-indigo-500/20"
                          checked={selectedDocs.includes(doc.filename)}
                          onChange={() => toggleDocSelection(doc.filename)}
                        />
                        <span className="text-sm text-white/70 truncate">{doc.filename}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Chat Messages */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {messages.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center opacity-40">
              <Network className="w-12 h-12 mb-4 text-indigo-400" />
              <p className="text-center text-sm uppercase tracking-widest font-medium">Zero-Hallucination<br/>Graph Context</p>
            </div>
          ) : (
            messages.map((m, i) => (
              <motion.div 
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                key={i} 
                className={`flex flex-col ${m.role === 'user' ? 'items-end' : 'items-start'}`}
              >
                <div className={`max-w-[85%] rounded-2xl px-5 py-3.5 text-sm leading-relaxed ${
                  m.role === 'user' 
                    ? 'bg-indigo-600 text-white' 
                    : 'bg-white/[0.04] border border-white/[0.08] text-white/90'
                }`}>
                  {m.role === 'user' ? (
                     m.content 
                  ) : (
                     <div className="prose prose-invert prose-sm max-w-none">
                       <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                     </div>
                  )}
                </div>
                
                {m.role === 'assistant' && m.suggestions && m.suggestions.length > 0 && (
                  <div className="flex flex-wrap gap-2 mt-3 ml-2">
                    {m.suggestions.map((sug, idx) => (
                      <button 
                        key={idx} 
                        onClick={() => handleSend(sug)}
                        disabled={loading}
                        className="px-3 py-1.5 rounded-full bg-indigo-500/10 hover:bg-indigo-500/20 border border-indigo-500/20 text-indigo-300 text-xs font-medium transition-colors"
                      >
                        {sug}
                      </button>
                    ))}
                  </div>
                )}
              </motion.div>
            ))
          )}
          
          {loading && messages[messages.length - 1]?.role !== 'assistant' && (
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="flex items-center gap-3 text-white/40 text-sm font-medium px-2"
            >
              <div className="flex gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-bounce"></span>
                <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-bounce" style={{ animationDelay: '150ms' }}></span>
                <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-bounce" style={{ animationDelay: '300ms' }}></span>
              </div>
              Semantic Entity Resolution...
            </motion.div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Input Area */}
        <div className="p-4 border-t border-white/[0.08] bg-white/[0.01]">
          <div className="relative flex items-end gap-2 bg-[#111113] border border-white/[0.08] focus-within:border-indigo-500/50 focus-within:ring-1 focus-within:ring-indigo-500/50 rounded-2xl transition-all p-2">
            <textarea
              ref={textareaRef}
              className="flex-1 max-h-40 min-h-[44px] bg-transparent text-sm text-white placeholder-white/30 resize-none outline-none py-3 px-3 leading-relaxed"
              placeholder="Ask about your documents..."
              rows={1}
              value={input}
              onChange={handleTextareaInput}
              onKeyDown={handleKeyDown}
              disabled={loading}
            />
            <button
              onClick={() => handleSend()}
              disabled={!input.trim() || loading}
              className="shrink-0 w-10 h-10 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:bg-white/[0.05] disabled:text-white/30 text-white flex items-center justify-center transition-all mb-0.5"
            >
              <Send className="w-4 h-4" />
            </button>
          </div>
        </div>
      </section>

      {/* Right Graph Panel */}
      <section className="hidden md:flex flex-1 flex-col bg-[#050505] relative overflow-hidden">
        <div className="absolute inset-x-0 top-0 h-16 bg-gradient-to-b from-[#0A0A0B]/80 to-transparent z-10 pointer-events-none"></div>
        <div className="absolute inset-0 opacity-40 mix-blend-screen bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-indigo-900/20 via-transparent to-transparent pointer-events-none"></div>
        <ForceGraph data={graph} onNodeClick={handleNodeClick} />
      </section>
    </div>
  );
}
