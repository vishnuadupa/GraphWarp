"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/browser-client";
import {
  ForceGraph,
  type GraphData,
  type GraphNode,
  type GraphLayout,
  type ThinkingPhase,
  TYPE_COLORS,
  ALL_TYPES,
} from "@/components/ForceGraph";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { motion, AnimatePresence } from "framer-motion";
import {
  Send, Filter, Network, ChevronDown, Search, X,
  BarChart2, Download, ExternalLink, ArrowRight,
  MessageSquare, Plus, PanelLeft, GitMerge, Loader2, Sliders,
} from "lucide-react";

interface Message {
  role: "user" | "assistant";
  content: string;
  suggestions?: string[];
}

interface Conversation {
  id: string;
  title: string | null;
  updated_at: string;
}

interface GraphStats {
  nodeCount: number;
  linkCount: number;
  typeDistribution: { type: string; count: number }[];
  topEntities: { name: string; type: string; degree: number }[];
  topRelationTypes: { type: string; count: number }[];
  docContributions: { doc: string; count: number }[];
}

interface NodeDetail {
  node: { name: string; type: string; degree: number };
  relationships: { relType: string; other: string; otherType: string; sourceFile: string; weight: number; isOutgoing: boolean }[];
  sourceDocs: string[];
}

const EMPTY_GRAPH: GraphData = { nodes: [], links: [] };

const TYPE_DOT_COLOR = (type: string) =>
  TYPE_COLORS[type as keyof typeof TYPE_COLORS] ?? "#4b5563";

function starterQuestions(entities: { name: string; type: string }[]): string[] {
  if (entities.length === 0) return [];
  const [a, b, c] = entities;
  const qs: string[] = [];
  if (a) qs.push(`Tell me about ${a.name}`);
  if (a && b) qs.push(`What is the relationship between ${a.name} and ${b.name}?`);
  if (c) qs.push(`What role does ${c.name} play in this knowledge base?`);
  qs.push("What are the most important concepts here?");
  return qs.slice(0, 4);
}

function fmtDate(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export default function ChatPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const userIdRef = useRef<string>("");

  // Conversation state
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [currentConvId, setCurrentConvId] = useState<string | null>(null);
  const [convLoading, setConvLoading] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  // Messages & chat
  const [messages, setMessages] = useState<Message[]>([]);
  const [graph, setGraph] = useState<GraphData>(EMPTY_GRAPH);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [availableDocs, setAvailableDocs] = useState<any[]>([]);
  const [selectedDocs, setSelectedDocs] = useState<string[]>([]);
  const [filterOpen, setFilterOpen] = useState(false);

  // Thinking animation
  const [thinkingPhase, setThinkingPhase] = useState<ThinkingPhase>(null);
  const [activeNodeIds, setActiveNodeIds] = useState<Set<string>>(new Set());
  const [matchedNodeIds, setMatchedNodeIds] = useState<Set<string>>(new Set());

  // Graph controls
  const [graphSearch, setGraphSearch] = useState("");
  const [searchResults, setSearchResults] = useState<Set<string>>(new Set());
  const [hiddenTypes, setHiddenTypes] = useState<Set<string>>(new Set());

  // Path finder
  const [pathFrom, setPathFrom] = useState("");
  const [pathTo, setPathTo] = useState("");
  const [pathLoading, setPathLoading] = useState(false);
  const [pathNodeIds, setPathNodeIds] = useState<Set<string>>(new Set());
  const [pathLength, setPathLength] = useState<number | null>(null);
  const [pathNotFound, setPathNotFound] = useState(false);
  const [pathOpen, setPathOpen] = useState(false);

  // Unified right panel: "stats" = Analytics tab, "node" = Details tab, null = closed
  const [rightPanel, setRightPanel] = useState<"stats" | "node" | null>(null);
  const [stats, setStats] = useState<GraphStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);

  // Node detail panel
  const [nodeDetail, setNodeDetail] = useState<NodeDetail | null>(null);
  const [nodeDetailLoading, setNodeDetailLoading] = useState(false);

  // View popover (layout + type filters)
  const [viewOpen, setViewOpen] = useState(false);

  const [convSearch, setConvSearch] = useState("");
  const [graphDocFilter, setGraphDocFilter] = useState<string | null>(null);
  const [graphLayout, setGraphLayout] = useState<GraphLayout>("force");

  const messagesEndRef          = useRef<HTMLDivElement>(null);
  const textareaRef             = useRef<HTMLTextAreaElement>(null);
  const searchDebounce          = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevSelectedDocsLength  = useRef<number>(0);
  const viewPopoverRef          = useRef<HTMLDivElement>(null);
  // Always-current graph ref so stream callbacks don't read stale state
  const graphRef                = useRef<GraphData>(EMPTY_GRAPH);

  // Cleanup debounce on unmount
  useEffect(() => () => { if (searchDebounce.current) clearTimeout(searchDebounce.current); }, []);

  // Keep graphRef current so stream handlers never read stale graph state
  useEffect(() => { graphRef.current = graph; }, [graph]);

  // Close View popover on outside click
  useEffect(() => {
    if (!viewOpen) return;
    const handler = (e: MouseEvent) => {
      if (viewPopoverRef.current && !viewPopoverRef.current.contains(e.target as Node)) {
        setViewOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [viewOpen]);

  // Auto-sync graph panel with the selected doc
  // When exactly 1 doc is checked, show only that doc's subgraph.
  // When going from 1 → 0 or 1 → multiple, restore the full graph.
  useEffect(() => {
    if (!ready) return;
    const prev = prevSelectedDocsLength.current;
    prevSelectedDocsLength.current = selectedDocs.length;
    if (selectedDocs.length === 1) {
      fetchGraphForDoc(selectedDocs[0]);
    } else if (prev === 1 && selectedDocs.length !== 1) {
      clearGraphDocFilter();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDocs, ready]);

  // ── Boot ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) { router.replace("/login"); return; }
      userIdRef.current = user.id;
      setReady(true);
      fetchDocuments();
      fetchFullGraph(user.id);
      fetchConversations();
    });
  }, [router]);

  // ── Graph with localStorage cache ────────────────────────────────────────
  const fetchFullGraph = async (uid: string) => {
    // Load from cache immediately for snappy UX
    try {
      const cached = localStorage.getItem(`graph_cache_${uid}`);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (parsed?.nodes?.length > 0) setGraph(parsed);
      }
    } catch { /* ignore */ }

    try {
      const res = await fetch("/api/graph/full");
      if (res.ok) {
        const data = await res.json();
        if (data.graph?.nodes?.length > 0) {
          setGraph(data.graph);
          try { localStorage.setItem(`graph_cache_${uid}`, JSON.stringify(data.graph)); } catch { /* quota */ }
        }
      }
    } catch (err) { console.error("Failed to load graph:", err); }
  };

  const fetchDocuments = async () => {
    try {
      const res = await fetch("/api/documents");
      if (res.ok) {
        const data = await res.json();
        setAvailableDocs(data.documents || []);
      }
    } catch (err) { console.error(err); }
  };

  // ── Conversation management ───────────────────────────────────────────────
  const fetchConversations = async () => {
    try {
      const res = await fetch("/api/conversations");
      if (res.ok) {
        const data = await res.json();
        setConversations(data.conversations || []);
      }
    } catch { /* silent */ }
  };

  const createConversation = async (title: string): Promise<string | null> => {
    try {
      const res = await fetch("/api/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: title.slice(0, 80) }),
      });
      if (res.ok) {
        const data = await res.json();
        const conv = data.conversation;
        setConversations((prev) => [conv, ...prev]);
        return conv.id;
      }
    } catch { /* silent */ }
    return null;
  };

  const loadConversation = async (convId: string) => {
    setConvLoading(true);
    setNodeDetail(null);
    setRightPanel(null);
    // Restore the full graph whenever switching conversations
    fetchFullGraph(userIdRef.current);
    try {
      const res = await fetch(`/api/conversations/${convId}`);
      if (res.ok) {
        const data = await res.json();
        const msgs: Message[] = (data.messages || []).map((m: any) => ({
          role: m.role,
          content: m.content || (m.role === "assistant" ? "_No response was recorded for this message._" : ""),
          suggestions: m.suggestions ?? undefined,
        }));
        // Filter out assistant messages with no meaningful content
        const filteredMsgs = msgs.filter((m) => m.role === "user" || m.content);
        setMessages(filteredMsgs);
        setCurrentConvId(convId);
      }
    } catch { /* silent */ }
    finally { setConvLoading(false); }
  };

  const saveMessage = async (
    convId: string,
    role: "user" | "assistant",
    content: string,
    suggestions?: string[]
  ) => {
    try {
      await fetch(`/api/conversations/${convId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role, content, suggestions: suggestions ?? null }),
      });
      // Refresh conversations to bump updated_at sort
      fetchConversations();
    } catch { /* non-fatal */ }
  };

  const handleNewConversation = () => {
    setCurrentConvId(null);
    setMessages([]);
    setNodeDetail(null);
    setPathNodeIds(new Set());
    setPathLength(null);
    setPathNotFound(false);
    setPathFrom("");
    setPathTo("");
    setPathOpen(false);
    setSelectedDocs([]);
    setGraphDocFilter(null);
    setGraphSearch("");
    setSearchResults(new Set());
    setRightPanel(null);
    fetchFullGraph(userIdRef.current);
  };

  const fetchGraphForDoc = async (doc: string) => {
    setGraphDocFilter(doc);
    try {
      const res = await fetch(`/api/graph/full?doc=${encodeURIComponent(doc)}`);
      if (res.ok) {
        const data = await res.json();
        if (data.graph) setGraph(data.graph);
      }
    } catch (err) { console.error("Failed to fetch doc graph:", err); }
  };

  const clearGraphDocFilter = () => {
    setGraphDocFilter(null);
    fetchFullGraph(userIdRef.current);
  };

  const handleSelectConversation = (conv: Conversation) => {
    if (conv.id === currentConvId) return;
    loadConversation(conv.id);
  };

  // ── Stats ─────────────────────────────────────────────────────────────────
  const fetchStats = useCallback(async () => {
    if (statsLoading) return;
    setStatsLoading(true);
    try {
      const res = await fetch("/api/graph/stats");
      if (res.ok) setStats(await res.json());
    } catch (err) { console.error(err); }
    finally { setStatsLoading(false); }
  }, [statsLoading]);

  const handleToggleStats = () => {
    if (rightPanel !== "stats") {
      fetchStats();
      setRightPanel("stats");
    } else {
      setRightPanel(null);
    }
  };

  // ── Graph search ──────────────────────────────────────────────────────────
  const handleGraphSearch = (q: string) => {
    setGraphSearch(q);
    if (searchDebounce.current) clearTimeout(searchDebounce.current);
    if (!q.trim()) { setSearchResults(new Set()); return; }
    searchDebounce.current = setTimeout(async () => {
      try {
        const res = await fetch("/api/graph/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: q }),
        });
        if (res.ok) {
          const data = await res.json();
          setSearchResults(new Set<string>((data.nodes as GraphNode[]).map((n) => n.id)));
        }
      } catch { setSearchResults(new Set()); }
    }, 250);
  };

  // ── Path finder ───────────────────────────────────────────────────────────
  const handleFindPath = async () => {
    if (!pathFrom.trim() || !pathTo.trim() || pathLoading) return;
    setPathLoading(true);
    setPathNodeIds(new Set());
    setPathLength(null);
    setPathNotFound(false);
    try {
      const res = await fetch("/api/graph/path", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: pathFrom.trim(), to: pathTo.trim() }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.found && data.graph?.nodes?.length > 0) {
          // Merge path nodes into graph
          setGraph((prev) => {
            const nodeMap = new Set(prev.nodes.map((n) => n.id));
            const linkExists = (l: any) => {
              const sId = typeof l.source === "object" ? l.source.id : l.source;
              const tId = typeof l.target === "object" ? l.target.id : l.target;
              return prev.links.some((ex: any) => {
                const exs = typeof ex.source === "object" ? ex.source.id : ex.source;
                const ext = typeof ex.target === "object" ? ex.target.id : ex.target;
                return exs === sId && ext === tId && ex.label === l.label;
              });
            };
            const newNodes = [...prev.nodes, ...data.graph.nodes.filter((n: any) => !nodeMap.has(n.id))];
            const newLinks = [...prev.links, ...data.graph.links.filter((l: any) => !linkExists(l))];
            return { nodes: newNodes, links: newLinks };
          });
          setPathNodeIds(new Set<string>(data.graph.nodes.map((n: any) => n.id)));
          setPathLength(data.length);
        } else {
          setPathNotFound(true);
        }
      }
    } catch { /* silent */ }
    finally { setPathLoading(false); }
  };

  const clearPath = () => {
    setPathNodeIds(new Set());
    setPathLength(null);
    setPathNotFound(false);
    setPathFrom("");
    setPathTo("");
  };

  // ── Node click ────────────────────────────────────────────────────────────
  const handleNodeClick = useCallback(async (node: any) => {
    fetch("/api/graph/expand", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nodeId: node.id }),
    })
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (!data) return;
        setGraph((prev) => {
          const newNodes = [...prev.nodes];
          const newLinks = [...prev.links];
          const nodeMap = new Set(newNodes.map((n) => n.id));
          data.graph.nodes.forEach((n: any) => { if (!nodeMap.has(n.id)) { newNodes.push(n); nodeMap.add(n.id); } });
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
      });

    setNodeDetail(null);
    setRightPanel("node");
    setNodeDetailLoading(true);
    try {
      const res = await fetch("/api/graph/node", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nodeId: node.id }),
      });
      if (res.ok) setNodeDetail(await res.json());
    } catch { /* silent */ }
    finally { setNodeDetailLoading(false); }
  }, []);

  // ── Type filter ───────────────────────────────────────────────────────────
  const toggleType = (type: string) => {
    setHiddenTypes((prev) => {
      const s = new Set(prev);
      s.has(type) ? s.delete(type) : s.add(type);
      return s;
    });
  };

  // ── Export ────────────────────────────────────────────────────────────────
  const handleExport = () => {
    const blob = new Blob([JSON.stringify(graph, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "knowledge-graph.json"; a.click();
    URL.revokeObjectURL(url);
  };

  // ── Scroll ────────────────────────────────────────────────────────────────
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // ── Send ──────────────────────────────────────────────────────────────────
  const handleSend = async (textOverride?: string) => {
    const text = textOverride || input.trim();
    if (!text || loading) return;

    const userMsg: Message = { role: "user", content: text };
    const historyForApi = [...messages]; // snapshot before adding new user msg

    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setLoading(true);
    setThinkingPhase("searching");
    setActiveNodeIds(new Set());
    setMatchedNodeIds(new Set());
    setNodeDetail(null);
    setPathNodeIds(new Set());
    setPathLength(null);
    if (textareaRef.current) textareaRef.current.style.height = "auto";

    // Ensure we have a conversation to save to
    let convId = currentConvId;
    if (!convId) {
      convId = await createConversation(text);
      if (convId) setCurrentConvId(convId);
    }

    // Save user message
    if (convId) await saveMessage(convId, "user", text);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: text,
          selectedDocs,
          messageHistory: historyForApi.map((m) => ({ role: m.role, content: m.content })),
        }),
      });
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || `API ${res.status}`); }
      if (!res.body) throw new Error("No response body");

      setMessages((prev) => [...prev, { role: "assistant", content: "" }]);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let done = false; let assistantMessage = ""; let buffer = "";
      let finalSuggestions: string[] = [];

      while (!done) {
        const { value, done: rd } = await reader.read();
        done = rd;
        if (value) {
          buffer += decoder.decode(value, { stream: true });
          const blocks = buffer.split("\n\n"); buffer = blocks.pop() || "";
          for (const block of blocks) {
            if (!block.startsWith("data: ")) continue;
            const dataStr = block.slice(6);
            if (dataStr === "[DONE]") continue;
            let parsed: any;
            try { parsed = JSON.parse(dataStr); } catch { continue; } // skip malformed chunks
            if (parsed.type === "phase") {
              setThinkingPhase(parsed.data as ThinkingPhase);
            } else if (parsed.type === "entities") {
              // Server just finished extracting entity names — immediately highlight any
              // matching nodes already in the loaded graph (avoids waiting for Neo4j).
              const names: string[] = parsed.data ?? [];
              const lowerNames = names.map((e: string) => e.toLowerCase());
              const matched = new Set<string>(
                graphRef.current.nodes
                  .filter((n) => lowerNames.some((e) => n.name.toLowerCase() === e || n.name.toLowerCase().includes(e)))
                  .map((n) => n.id)
              );
              if (matched.size > 0) setMatchedNodeIds(matched);
            } else if (parsed.type === "graph") {
              // Only replace the graph if we actually got nodes back — never clear a populated graph
              if (parsed.data?.nodes?.length > 0) setGraph(parsed.data);
              // matchedNodeIds = direct entity hits; activeNodeIds = full subgraph
              if (parsed.matchedNodeIds?.length > 0) setMatchedNodeIds(new Set<string>(parsed.matchedNodeIds));
              if (parsed.activeNodeIds?.length > 0) setActiveNodeIds(new Set<string>(parsed.activeNodeIds));
            } else if (parsed.type === "text") {
              assistantMessage += parsed.data;
              let displayContent = assistantMessage;
              const m = assistantMessage.match(/<suggestions>([\s\S]*?)<\/suggestions>/);
              if (m) {
                displayContent = assistantMessage.replace(m[0], "").trim();
                try { finalSuggestions = JSON.parse(m[1]); } catch { /* */ }
              }
              setMessages((prev) => {
                const msgs = [...prev];
                const last = msgs[msgs.length - 1];
                last.content = displayContent;
                if (finalSuggestions.length > 0) last.suggestions = finalSuggestions;
                return msgs;
              });
            } else if (parsed.type === "error") {
              throw new Error(parsed.data); // now correctly propagates to outer catch
            }
          }
        }
      }

      // Save assistant message (only if there's actual content)
      if (convId) {
        const m = assistantMessage.match(/<suggestions>([\s\S]*?)<\/suggestions>/);
        const cleanContent = m ? assistantMessage.replace(m[0], "").trim() : assistantMessage.trim();
        if (cleanContent) {
          await saveMessage(convId, "assistant", cleanContent, finalSuggestions.length > 0 ? finalSuggestions : undefined);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      const errorContent = `⚠️ ${msg}`;
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.role === "assistant" && last.content === "") {
          const msgs = [...prev]; msgs[msgs.length - 1].content = errorContent; return msgs;
        }
        return [...prev, { role: "assistant", content: errorContent }];
      });
      // Persist error so it's visible after reload
      if (convId) await saveMessage(convId, "assistant", errorContent);
    } finally {
      setLoading(false);
      setThinkingPhase(null);
      setTimeout(() => { setActiveNodeIds(new Set()); setMatchedNodeIds(new Set()); }, 3000);
      if (rightPanel === "stats") fetchStats();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };
  const handleTextareaInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    const el = e.target; el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  };
  const toggleDocSelection = (filename: string) =>
    setSelectedDocs((prev) =>
      prev.includes(filename) ? prev.filter((d) => d !== filename) : [...prev, filename]
    );

  const starterQs = starterQuestions(
    stats?.topEntities ?? graph.nodes.slice(0, 3).map((n) => ({ name: n.name, type: n.type ?? "Entity" }))
  );

  if (!ready) return null;

  return (
    <div className="flex-1 flex flex-col md:flex-row h-full overflow-hidden bg-[var(--color-paper)] text-[var(--color-ink)]">

      {/* ── Conversation Sidebar ─────────────────────────────────────────── */}
      <AnimatePresence initial={false}>
        {sidebarOpen && (
          <motion.aside
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: 260, opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={{ type: "spring", stiffness: 320, damping: 32 }}
            className="hidden md:flex flex-col shrink-0 border-r-[2px] border-[var(--color-rule)] bg-[var(--color-paper-2)] overflow-hidden"
            style={{ minWidth: 0 }}
          >
            {/* Sidebar header */}
            <div className="h-14 flex items-center justify-between px-4 border-b-[2px] border-[var(--color-rule)] bg-[var(--color-paper-3)] shrink-0">
              <span className="text-[10px] font-bold text-[var(--color-ink)] font-mono uppercase tracking-widest">Conversations</span>
              <button
                onClick={handleNewConversation}
                className="w-7 h-7 rounded-none border-[1px] border-[var(--color-rule)] bg-[var(--color-paper)] hover:bg-[var(--color-ink)] hover:text-[var(--color-paper)] text-[var(--color-ink)] flex items-center justify-center transition-all shadow-sm cursor-pointer"
                title="New conversation"
              >
                <Plus className="w-3.5 h-3.5" />
              </button>
            </div>

            {/* Conversation search */}
            <div className="px-3 py-2 border-b-[1px] border-[var(--color-rule)] shrink-0">
              <div className="flex items-center gap-2 bg-[var(--color-paper)] border-[1px] border-[var(--color-rule)] px-2 py-1.5">
                <Search className="w-3 h-3 text-[var(--color-neutral)] shrink-0" />
                <input
                  className="flex-1 bg-transparent text-[10px] font-mono text-[var(--color-ink)] placeholder-[var(--color-neutral)] outline-none"
                  placeholder="Search…"
                  value={convSearch}
                  onChange={(e) => setConvSearch(e.target.value)}
                />
                {convSearch && <button onClick={() => setConvSearch("")} className="text-[var(--color-neutral)] hover:text-[var(--color-ink)]"><X className="w-3 h-3" /></button>}
              </div>
            </div>

            {/* Conversations list */}
            <div className="flex-1 overflow-y-auto py-1">
              {conversations.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-32 gap-2 opacity-40">
                  <MessageSquare className="w-5 h-5 text-[var(--color-ink)]" />
                  <span className="text-[10px] font-mono uppercase tracking-widest text-[var(--color-neutral)] text-center">Empty</span>
                </div>
              ) : (
                conversations
                  .filter((c) => !convSearch || (c.title ?? "New conversation").toLowerCase().includes(convSearch.toLowerCase()))
                  .map((conv) => (
                    <button
                      key={conv.id}
                      onClick={() => handleSelectConversation(conv)}
                      className={`w-full text-left px-4 py-3 transition-colors group relative border-b-[1px] border-[var(--color-rule)] cursor-pointer ${
                        conv.id === currentConvId
                          ? "bg-[var(--color-paper)] border-r-[3px] border-[var(--color-ink)]"
                          : "hover:bg-[var(--color-paper-3)]"
                      }`}
                    >
                      <p className={`text-xs truncate font-mono font-bold leading-snug ${conv.id === currentConvId ? "text-[var(--color-ink)]" : "text-[var(--color-neutral)]"}`}>
                        {conv.title || "New conversation"}
                      </p>
                      <p className="text-[10px] font-mono text-[var(--color-neutral)] mt-0.5">{fmtDate(conv.updated_at)}</p>
                    </button>
                  ))
              )}
            </div>
          </motion.aside>
        )}
      </AnimatePresence>

      {/* ── Chat Panel ──────────────────────────────────────────────────────── */}
      <section className="flex-1 flex flex-col min-w-[280px] border-r-[2px] border-[var(--color-rule)] bg-[var(--color-paper)] relative h-full">

        {/* Header */}
        <div className="h-14 flex items-center justify-between px-4 border-b-[2px] border-[var(--color-rule)] bg-[var(--color-paper-2)] shrink-0 gap-2">
          <div className="flex items-center gap-3">
            {/* Sidebar toggle */}
            <button
              onClick={() => setSidebarOpen((v) => !v)}
              className="hidden md:flex w-7 h-7 rounded-none border-[1px] border-[var(--color-rule)] bg-[var(--color-paper)] hover:bg-[var(--color-paper-3)] text-[var(--color-ink)] items-center justify-center transition-colors shadow-sm cursor-pointer"
              title={sidebarOpen ? "Hide conversations" : "Show conversations"}
            >
              <PanelLeft className="w-3.5 h-3.5" />
            </button>
            <h2 className="font-bold text-[var(--color-ink)] text-xs font-mono uppercase tracking-widest truncate max-w-[200px] sm:max-w-xs">
              {currentConvId
                ? conversations.find((c) => c.id === currentConvId)?.title || "Chat"
                : "New Chat"}
            </h2>
          </div>

          {availableDocs.length > 0 && (
            <div className="relative">
              <button onClick={() => setFilterOpen(!filterOpen)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-none bg-[var(--color-paper)] border-[2px] border-[var(--color-rule)] hover:bg-[var(--color-paper-3)] text-xs text-[var(--color-ink)] font-mono font-bold uppercase transition-colors shadow-sm cursor-pointer border-solid">
                <Filter className="w-3 h-3" />
                {selectedDocs.length === 0
                  ? "All Docs"
                  : selectedDocs.length === 1
                  ? <span className="max-w-[120px] truncate block">{selectedDocs[0]}</span>
                  : `${selectedDocs.length} docs`}
                <ChevronDown className="w-3 h-3 opacity-60" />
              </button>
              {filterOpen && (
                <div className="absolute right-0 top-full mt-2 w-64 rounded-none bg-[var(--color-paper)] border-[2px] border-[var(--color-rule)] border-solid shadow-md z-50 overflow-hidden">
                  <div className="p-2 border-b border-[var(--color-rule)] border-solid bg-[var(--color-paper-2)]">
                    <label className="flex items-center gap-3 px-3 py-2 hover:bg-[var(--color-paper-3)] cursor-pointer">
                      <input type="checkbox" className="rounded-none text-[var(--color-ink)] focus:ring-0 border-[var(--color-rule)]" checked={selectedDocs.length === 0} onChange={() => setSelectedDocs([])} />
                      <span className="text-xs font-mono uppercase tracking-wider font-bold text-[var(--color-ink)]">All Documents</span>
                    </label>
                  </div>
                  <div className="p-2 max-h-52 overflow-y-auto bg-[var(--color-paper)]">
                    {availableDocs.map((doc) => (
                      <div key={doc.id} className="flex items-center gap-1 px-1 py-1 hover:bg-[var(--color-paper-2)] group">
                        <label className="flex items-center gap-2 flex-1 min-w-0 cursor-pointer py-1 px-2">
                          <input type="checkbox" className="rounded-none text-[var(--color-ink)] focus:ring-0 border-[var(--color-rule)] shrink-0" checked={selectedDocs.includes(doc.filename)} onChange={() => toggleDocSelection(doc.filename)} />
                          <span className="text-xs font-mono text-[var(--color-neutral)] truncate">{doc.filename}</span>
                        </label>
                        <button
                          onClick={() => { fetchGraphForDoc(doc.filename); setFilterOpen(false); }}
                          title="View only this file in graph"
                          className="shrink-0 px-2 py-1 text-[9px] font-mono uppercase tracking-widest border-[1px] border-[var(--color-rule)] bg-[var(--color-paper-2)] hover:bg-[var(--color-ink)] hover:text-[var(--color-paper)] text-[var(--color-neutral)] transition-colors cursor-pointer opacity-0 group-hover:opacity-100">
                          Graph
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Processing banner — shown when any uploaded doc is still being extracted */}
        {availableDocs.some((d: any) => d.status === "Processing") && (
          <div className="flex items-center gap-3 px-4 py-2.5 bg-amber-50 border-b-[2px] border-amber-200 text-amber-800 text-xs font-mono shrink-0">
            <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
            <span>
              {availableDocs.filter((d: any) => d.status === "Processing").length} file
              {availableDocs.filter((d: any) => d.status === "Processing").length !== 1 ? "s" : ""}{" "}
              still being extracted — results will appear once processing completes.
            </span>
            <a href="/documents" className="ml-auto underline hover:text-amber-900 shrink-0">View status</a>
          </div>
        )}

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-6 py-8 space-y-8 bg-[var(--color-paper)]">
          {convLoading ? (
            <div className="h-full flex items-center justify-center">
              <Loader2 className="w-6 h-6 text-[var(--color-ink)] animate-spin" />
            </div>
          ) : messages.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center gap-8 max-w-lg mx-auto">
              <div className="border-[2px] border-[var(--color-rule)] border-solid bg-[var(--color-paper-2)] p-6 text-center rounded-none shadow-sm w-full">
                <div className="w-12 h-12 rounded-none border-[1px] border-[var(--color-rule)] border-solid bg-[var(--color-paper)] flex items-center justify-center mx-auto mb-4 text-[var(--color-ink)]">
                  <Network className="w-6 h-6" />
                </div>
                <p className="text-xs uppercase tracking-widest font-bold font-mono text-[var(--color-ink)] leading-relaxed">Zero-Hallucination<br />Graph Context RAG</p>
                <p className="text-xs text-[var(--color-neutral)] font-body mt-2 leading-relaxed">
                  Query the knowledge graph with zero hallucination guarantee. Entities and facts are extracted automatically from private workspace ingestion.
                </p>
              </div>
              {starterQs.length > 0 && (
                <div className="w-full space-y-2">
                  <p className="text-[10px] text-[var(--color-neutral)] text-center uppercase tracking-widest font-mono font-bold mb-3">Try asking the graph</p>
                  {starterQs.map((q, i) => (
                    <button key={i} onClick={() => handleSend(q)}
                      className="w-full text-left px-4 py-3 rounded-none bg-[var(--color-paper)] hover:bg-[var(--color-ink)] hover:text-[var(--color-paper)] border-[2px] border-[var(--color-rule)] border-solid text-xs font-mono font-bold uppercase tracking-wider transition-all flex items-center justify-between group shadow-sm cursor-pointer">
                      <span className="truncate pr-4">{q}</span>
                      <ArrowRight className="w-4 h-4 shrink-0 opacity-40 group-hover:opacity-100 group-hover:translate-x-0.5 transition-all" />
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="max-w-2xl mx-auto w-full space-y-6 flex flex-col pb-2">
              {messages.map((m, i) => (
                <motion.div key={i} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
                  className={`flex gap-3 ${m.role === "user" ? "flex-row-reverse" : "flex-row"}`}>

                  {/* Avatar */}
                  {m.role === "assistant" && (
                    <div className="shrink-0 w-7 h-7 mt-0.5 bg-[var(--color-ink)] text-[var(--color-paper)] flex items-center justify-center text-[9px] font-bold font-mono border-[1px] border-[var(--color-rule)]">
                      GW
                    </div>
                  )}

                  <div className={`flex flex-col gap-2 ${m.role === "user" ? "items-end max-w-[80%]" : "items-start flex-1 min-w-0"}`}>
                    {m.role === "user" ? (
                      /* User bubble — dark filled, right side */
                      <div className="bg-[var(--color-ink)] text-[var(--color-paper)] px-4 py-3 text-sm leading-relaxed font-medium">
                        {m.content}
                      </div>
                    ) : (
                      /* AI response — clean, left side, no border */
                      <div className="w-full">
                        <div className="prose prose-neutral max-w-none prose-sm leading-relaxed text-[var(--color-ink)] font-body
                          prose-headings:font-bold prose-headings:text-[var(--color-ink)] prose-headings:mt-4 prose-headings:mb-2
                          prose-p:my-1.5 prose-li:my-0.5 prose-code:text-[var(--color-ink)] prose-code:bg-[var(--color-paper-2)] prose-code:px-1 prose-code:py-0.5 prose-code:text-xs prose-code:font-mono">
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                        </div>
                        {/* Suggestions — follow-up chips */}
                        {m.suggestions && m.suggestions.length > 0 && (
                          <div className="flex flex-wrap gap-1.5 mt-3">
                            {m.suggestions.map((sug, idx) => (
                              <button key={idx} onClick={() => handleSend(sug)} disabled={loading}
                                className="px-3 py-1.5 bg-[var(--color-paper-2)] hover:bg-[var(--color-ink)] hover:text-[var(--color-paper)] border-[1px] border-[var(--color-rule)] text-[var(--color-ink)] text-[11px] font-mono transition-colors cursor-pointer disabled:opacity-40 text-left leading-snug">
                                {sug}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </motion.div>
              ))}
            </div>
          )}

          {loading && messages[messages.length - 1]?.role !== "assistant" && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}
              className="max-w-2xl mx-auto flex items-center gap-3 text-[var(--color-neutral)] text-xs font-mono uppercase tracking-widest px-2 pt-2">
              <div className="flex gap-1">
                {[0, 150, 300].map((d) => (
                  <span key={d} className="w-2 h-2 rounded-none bg-[var(--color-ink)] animate-bounce" style={{ animationDelay: `${d}ms` }} />
                ))}
              </div>
              <span className="font-bold">
                {thinkingPhase === "searching"  && "Resolving entities…"}
                {thinkingPhase === "traversing" && "Traversing graph…"}
                {thinkingPhase === "answering"  && "Synthesising answer…"}
                {!thinkingPhase                 && "Thinking…"}
              </span>
            </motion.div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Floating Bottom Input */}
        <div className="p-4 max-w-3xl mx-auto w-full bg-[var(--color-paper)]/90 backdrop-blur-md sticky bottom-0 z-10 border-t border-[var(--color-rule)]/20 shrink-0">
          <div className="flex items-end gap-2 bg-[var(--color-paper-2)] border-[2px] border-[var(--color-rule)] border-solid focus-within:border-[var(--color-ink)] focus-within:shadow-md transition-all p-2 rounded-none">
            <textarea ref={textareaRef}
              className="flex-1 max-h-36 min-h-[42px] bg-transparent text-sm text-[var(--color-ink)] placeholder-[var(--color-neutral)] resize-none outline-none py-2 px-3 leading-relaxed font-body"
              placeholder="Ask about entities or paths in your documents…" rows={1}
              value={input} onChange={handleTextareaInput} onKeyDown={handleKeyDown} disabled={loading} />
            <button onClick={() => handleSend()} disabled={!input.trim() || loading}
              className="shrink-0 w-9 h-9 bg-[var(--color-ink)] text-[var(--color-paper)] disabled:opacity-40 disabled:bg-[var(--color-paper-3)] text-white flex items-center justify-center transition-all mb-0.5 rounded-none border-[1px] border-[var(--color-rule)] border-solid cursor-pointer"
              title="Send message">
              <Send className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </section>

      {/* ── Graph Panel ──────────────────────────────────────────────────────── */}
      <section className="hidden md:flex flex-col flex-1 bg-[var(--color-paper)] relative overflow-hidden">

        {/* Graph toolbar */}
        <div className="h-14 flex items-center gap-3 px-4 border-b-[2px] border-[var(--color-rule)] border-solid bg-[var(--color-paper-2)] z-20 shrink-0 flex-wrap">
          {/* Node search */}
          <div className="flex items-center gap-2 bg-[var(--color-paper)] border-[2px] border-[var(--color-rule)] border-solid rounded-none px-3 py-1.5 max-w-[180px]">
            <Search className="w-3.5 h-3.5 text-[var(--color-neutral)] shrink-0" />
            <input
              className="bg-transparent text-xs text-[var(--color-ink)] placeholder-[var(--color-neutral)] outline-none flex-1 min-w-0 font-mono"
              placeholder="Search nodes…"
              value={graphSearch}
              onChange={(e) => handleGraphSearch(e.target.value)}
            />
            {graphSearch && (
              <button onClick={() => { setGraphSearch(""); setSearchResults(new Set()); }} className="text-[var(--color-neutral)] hover:text-[var(--color-ink)] cursor-pointer">
                <X className="w-3 h-3" />
              </button>
            )}
          </div>

          {/* View popover — layout + entity type filters */}
          <div className="relative shrink-0" ref={viewPopoverRef}>
            <button
              onClick={() => setViewOpen((v) => !v)}
              title="Layout & type filters"
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-none border-[2px] border-[var(--color-rule)] border-solid text-xs font-mono uppercase tracking-widest font-bold transition-all cursor-pointer ${
                viewOpen || hiddenTypes.size > 0 || graphLayout !== "force"
                  ? "bg-[var(--color-ink)] text-[var(--color-paper)] shadow-md"
                  : "bg-[var(--color-paper)] hover:bg-[var(--color-paper-2)] text-[var(--color-ink)] shadow-sm"
              }`}
            >
              <Sliders className="w-3.5 h-3.5" />
              View
              {(hiddenTypes.size > 0 || graphLayout !== "force") && (
                <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />
              )}
            </button>

            {viewOpen && (
              <div className="absolute left-0 top-full mt-2 w-52 bg-[var(--color-paper)] border-[2px] border-[var(--color-rule)] border-solid shadow-md z-50 overflow-hidden">
                {/* Layout section */}
                <div className="p-3 border-b-[1px] border-[var(--color-rule)] border-solid">
                  <div className="text-[9px] font-mono uppercase tracking-widest text-[var(--color-neutral)] font-bold mb-2">Layout</div>
                  <div className="grid grid-cols-3 gap-1">
                    {(
                      [
                        { key: "force",        label: "Force"  },
                        { key: "circular",     label: "Circle" },
                        { key: "radial",       label: "Radial" },
                        { key: "hierarchical", label: "Tree"   },
                        { key: "grid",         label: "Grid"   },
                      ] as { key: GraphLayout; label: string }[]
                    ).map(({ key, label }) => (
                      <button
                        key={key}
                        onClick={() => setGraphLayout(key)}
                        className={`px-1.5 py-1 text-[9px] font-mono uppercase tracking-widest font-bold border-[1px] border-[var(--color-rule)] border-solid transition-all cursor-pointer ${
                          graphLayout === key
                            ? "bg-[var(--color-ink)] text-[var(--color-paper)] border-[var(--color-ink)]"
                            : "bg-[var(--color-paper-2)] text-[var(--color-neutral)] hover:text-[var(--color-ink)]"
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Entity type filters */}
                {ALL_TYPES.filter((t) => graph.nodes.some((n) => (n.type ?? "Entity") === t)).length > 0 && (
                  <div className="p-3">
                    <div className="text-[9px] font-mono uppercase tracking-widest text-[var(--color-neutral)] font-bold mb-2">Entity Types</div>
                    <div className="space-y-1">
                      {ALL_TYPES.filter((t) => graph.nodes.some((n) => (n.type ?? "Entity") === t)).map((type) => (
                        <button
                          key={type}
                          onClick={() => toggleType(type)}
                          className={`w-full flex items-center gap-2.5 px-2 py-1.5 text-[10px] font-mono font-bold transition-all cursor-pointer border-[1px] border-solid ${
                            hiddenTypes.has(type)
                              ? "border-[var(--color-rule)] bg-[var(--color-paper-2)] text-[var(--color-neutral)] opacity-50"
                              : "border-[var(--color-rule)] bg-[var(--color-paper-2)] text-[var(--color-ink)] hover:bg-[var(--color-paper-3)]"
                          }`}
                        >
                          <span className="w-2.5 h-2.5 rounded-none border-[1px] border-[var(--color-rule)] border-solid shrink-0" style={{ background: TYPE_DOT_COLOR(type) }} />
                          <span className="flex-1 text-left">{type}</span>
                          {hiddenTypes.has(type) && <span className="text-[8px] text-[var(--color-neutral)] font-mono">hidden</span>}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="w-[2px] h-5 bg-[var(--color-rule)]" />

          {/* Path finder toggle */}
          <button onClick={() => { setPathOpen((v) => !v); if (pathOpen) clearPath(); }} title="Find shortest path"
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-none border-[2px] border-[var(--color-rule)] border-solid text-xs font-mono uppercase tracking-widest font-bold transition-all cursor-pointer ${pathOpen ? "bg-[var(--color-ink)] text-[var(--color-paper)] shadow-md" : "bg-[var(--color-paper)] hover:bg-[var(--color-paper-2)] text-[var(--color-ink)] shadow-sm"}`}>
            <GitMerge className="w-3.5 h-3.5" />
            Path
          </button>

          {/* Stats */}
          <button onClick={handleToggleStats} title="Graph statistics"
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-none border-[2px] border-[var(--color-rule)] border-solid text-xs font-mono uppercase tracking-widest font-bold transition-all cursor-pointer ${rightPanel === "stats" ? "bg-[var(--color-ink)] text-[var(--color-paper)] shadow-md" : "bg-[var(--color-paper)] hover:bg-[var(--color-paper-2)] text-[var(--color-ink)] shadow-sm"}`}>
            <BarChart2 className="w-3.5 h-3.5" />
            Stats
          </button>

          {/* Export */}
          {graph.nodes.length > 0 && (
            <button onClick={handleExport} title="Export graph as JSON"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-none bg-[var(--color-paper)] hover:bg-[var(--color-paper-2)] border-[2px] border-[var(--color-rule)] border-solid text-xs text-[var(--color-ink)] font-mono font-bold uppercase transition-all shadow-sm cursor-pointer">
              <Download className="w-3.5 h-3.5" />
              Export
            </button>
          )}
        </div>

        {/* Graph doc filter banner */}
        {graphDocFilter && (
          <div className="flex items-center justify-between px-4 py-2 bg-[var(--color-ink)] text-[var(--color-paper)] text-[10px] font-mono uppercase tracking-widest shrink-0">
            <span className="truncate">Showing: {graphDocFilter}</span>
            <button onClick={clearGraphDocFilter} className="flex items-center gap-1 shrink-0 ml-3 opacity-70 hover:opacity-100 cursor-pointer">
              <X className="w-3 h-3" /> Show All
            </button>
          </div>
        )}

        {/* Path finder bar */}
        <AnimatePresence>
          {pathOpen && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="border-b-[2px] border-[var(--color-rule)] border-solid bg-[var(--color-paper-2)] z-10 overflow-hidden shrink-0"
            >
              <div className="flex items-center gap-2.5 px-4 py-3">
                <input
                  className="flex-1 bg-[var(--color-paper)] border-[1px] border-[var(--color-rule)] border-solid rounded-none px-3 py-1.5 text-xs text-[var(--color-ink)] placeholder-[var(--color-neutral)] outline-none font-mono focus:border-[var(--color-ink)]"
                  placeholder="From entity…"
                  value={pathFrom}
                  onChange={(e) => setPathFrom(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleFindPath()}
                />
                <span className="text-[var(--color-rule)] text-xs shrink-0 font-bold">→</span>
                <input
                  className="flex-1 bg-[var(--color-paper)] border-[1px] border-[var(--color-rule)] border-solid rounded-none px-3 py-1.5 text-xs text-[var(--color-ink)] placeholder-[var(--color-neutral)] outline-none font-mono focus:border-[var(--color-ink)]"
                  placeholder="To entity…"
                  value={pathTo}
                  onChange={(e) => setPathTo(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleFindPath()}
                />
                <button
                  onClick={handleFindPath}
                  disabled={!pathFrom.trim() || !pathTo.trim() || pathLoading}
                  className="px-3 py-1.5 rounded-none bg-[var(--color-paper)] hover:bg-[var(--color-ink)] hover:text-[var(--color-paper)] border-[1px] border-[var(--color-rule)] border-solid text-[var(--color-ink)] text-xs font-mono font-bold uppercase transition-colors disabled:opacity-40 flex items-center gap-1.5 shrink-0 shadow-sm cursor-pointer"
                >
                  {pathLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <GitMerge className="w-3 h-3" />}
                  Find
                </button>
                {pathNodeIds.size > 0 && (
                  <button onClick={clearPath} className="text-[var(--color-neutral)] hover:text-[var(--color-ink)] cursor-pointer">
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
              {/* Path result status */}
              {pathNotFound && (
                <div className="px-4 pb-2.5 text-[10px] font-mono text-red-600 font-bold uppercase tracking-wider">No path found between these entities.</div>
              )}
              {pathLength !== null && (
                <div className="px-4 pb-2.5 text-[10px] font-mono text-teal-600 font-bold uppercase tracking-wider">
                  Path found — {pathLength} hop{pathLength !== 1 ? "s" : ""} · {pathNodeIds.size} nodes highlighted
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Search result count */}
        {searchResults.size > 0 && (
          <div className="absolute top-16 left-1/2 -translate-x-1/2 z-20 px-4 py-2 border-[2px] border-[var(--color-rule)] border-solid bg-[var(--color-paper-2)] font-mono text-xs uppercase tracking-wider font-bold shadow-md rounded-none text-[var(--color-ink)]">
            {searchResults.size} node{searchResults.size !== 1 ? "s" : ""} matched
          </div>
        )}

        {/* Force graph */}
        <div className="absolute inset-0 top-14 bg-white">
          <ForceGraph
            data={graph}
            layout={graphLayout}
            thinkingPhase={thinkingPhase}
            matchedNodeIds={matchedNodeIds.size > 0 ? matchedNodeIds : undefined}
            activeNodeIds={activeNodeIds}
            highlightNodeIds={searchResults.size > 0 ? searchResults : undefined}
            pathNodeIds={pathNodeIds.size > 0 ? pathNodeIds : undefined}
            pathLinkIds={pathNodeIds.size > 0 ? pathNodeIds : undefined}
            hiddenTypes={hiddenTypes.size > 0 ? hiddenTypes : undefined}
            onNodeClick={handleNodeClick}
          />
        </div>

        {/* ── Unified right panel (Details | Analytics) ──────────────── */}
        <AnimatePresence>
          {rightPanel !== null && (
            <motion.aside
              initial={{ x: "100%", opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: "100%", opacity: 0 }}
              transition={{ type: "spring", stiffness: 320, damping: 32 }}
              className="absolute right-0 top-14 bottom-0 w-80 bg-[var(--color-paper)] border-l-[2px] border-[var(--color-rule)] border-solid z-30 flex flex-col shadow-lg"
            >
              {/* Tab bar */}
              <div className="flex items-center shrink-0 border-b-[2px] border-[var(--color-rule)] border-solid bg-[var(--color-paper-2)]">
                <button
                  onClick={() => setRightPanel("node")}
                  disabled={!nodeDetail && !nodeDetailLoading}
                  className={`px-4 h-10 text-[10px] font-mono uppercase tracking-widest font-bold border-b-[2px] transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-30 ${
                    rightPanel === "node"
                      ? "border-[var(--color-ink)] text-[var(--color-ink)]"
                      : "border-transparent text-[var(--color-neutral)] hover:text-[var(--color-ink)]"
                  }`}
                >
                  Details
                </button>
                <button
                  onClick={() => { setRightPanel("stats"); if (!stats) fetchStats(); }}
                  className={`px-4 h-10 text-[10px] font-mono uppercase tracking-widest font-bold border-b-[2px] transition-colors cursor-pointer ${
                    rightPanel === "stats"
                      ? "border-[var(--color-ink)] text-[var(--color-ink)]"
                      : "border-transparent text-[var(--color-neutral)] hover:text-[var(--color-ink)]"
                  }`}
                >
                  Analytics
                </button>
                <button onClick={() => setRightPanel(null)} className="ml-auto mr-3 text-[var(--color-neutral)] hover:text-[var(--color-ink)] cursor-pointer">
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Content */}
              <div className="flex-1 overflow-y-auto">

                {/* ── Details tab ─────────────────────────────────── */}
                {rightPanel === "node" && (
                  nodeDetailLoading ? (
                    <div className="h-full flex items-center justify-center">
                      <div className="w-6 h-6 border-2 border-[var(--color-rule)] border-t-[var(--color-ink)] rounded-none animate-spin" />
                    </div>
                  ) : nodeDetail ? (
                    <div className="flex flex-col text-xs">
                      {/* Node header */}
                      <div className="p-4 border-b-[1px] border-[var(--color-rule)] border-solid bg-[var(--color-paper-2)]">
                        <div className="flex items-center gap-1.5 mb-1">
                          <span className="w-2.5 h-2.5 rounded-none border-[1px] border-[var(--color-rule)] border-solid shrink-0" style={{ background: TYPE_DOT_COLOR(nodeDetail.node.type) }} />
                          <span className="text-[9px] font-bold font-mono text-[var(--color-neutral)] uppercase tracking-wider">{nodeDetail.node.type}</span>
                        </div>
                        <h3 className="text-xs font-bold font-mono text-[var(--color-ink)] uppercase tracking-wide">{nodeDetail.node.name}</h3>
                        <p className="text-[10px] font-mono text-[var(--color-neutral)] uppercase tracking-widest mt-0.5">{nodeDetail.node.degree} connections</p>
                        <div className="flex gap-1.5 mt-3">
                          <button onClick={() => handleSend(`Tell me about ${nodeDetail.node.name}`)} title="Ask about this entity"
                            className="flex items-center gap-1.5 px-2.5 py-1 rounded-none bg-[var(--color-paper)] border-[1px] border-[var(--color-rule)] border-solid hover:bg-[var(--color-ink)] hover:text-[var(--color-paper)] text-[var(--color-ink)] text-[9px] font-mono uppercase tracking-widest font-bold transition-all cursor-pointer">
                            <ExternalLink className="w-3 h-3" />Ask
                          </button>
                          <button onClick={() => { setPathOpen(true); setPathFrom(nodeDetail.node.name); }} title="Find path from this node"
                            className="flex items-center gap-1.5 px-2.5 py-1 rounded-none bg-[var(--color-paper)] border-[1px] border-[var(--color-rule)] border-solid hover:bg-[var(--color-ink)] hover:text-[var(--color-paper)] text-[var(--color-ink)] text-[9px] font-mono uppercase tracking-widest font-bold transition-all cursor-pointer">
                            <GitMerge className="w-3 h-3" />Path
                          </button>
                        </div>
                      </div>

                      <div className="p-4 space-y-5">
                        {nodeDetail.sourceDocs.length > 0 && (
                          <div>
                            <div className="text-[var(--color-neutral)] font-mono uppercase tracking-widest font-bold mb-2">Source Documents</div>
                            <div className="space-y-1">
                              {nodeDetail.sourceDocs.map((doc) => (
                                <div key={doc} className="px-3 py-2 rounded-none bg-[var(--color-paper-2)] border-[1px] border-[var(--color-rule)] border-solid text-[var(--color-ink)] text-[9px] font-mono truncate">{doc}</div>
                              ))}
                            </div>
                          </div>
                        )}
                        <div>
                          <div className="text-[var(--color-neutral)] font-mono uppercase tracking-widest font-bold mb-2">Relationships ({nodeDetail.relationships.length})</div>
                          <div className="space-y-1.5">
                            {nodeDetail.relationships.map((r, idx) => (
                              <button key={idx} onClick={() => handleNodeClick({ id: r.other })}
                                className="w-full text-left px-3 py-2.5 rounded-none bg-[var(--color-paper-2)] border-[1px] border-[var(--color-rule)] border-solid hover:bg-[var(--color-paper-3)] transition-colors group cursor-pointer">
                                <div className="flex items-center gap-1 text-[var(--color-neutral)] text-[9px] font-mono uppercase mb-1">
                                  {r.isOutgoing ? (
                                    <><span className="text-[var(--color-ink)] font-bold">{nodeDetail.node.name.slice(0,10)}..</span> → <span className="font-bold text-[var(--color-ink)]">{r.relType}</span> →</>
                                  ) : (
                                    <>← <span className="font-bold text-[var(--color-ink)]">{r.relType}</span> ← <span className="text-[var(--color-ink)] font-bold">{nodeDetail.node.name.slice(0,10)}..</span></>
                                  )}
                                </div>
                                <div className="flex items-center gap-2">
                                  <span className="w-2 h-2 rounded-none border-[1px] border-[var(--color-rule)] border-solid shrink-0" style={{ background: TYPE_DOT_COLOR(r.otherType) }} />
                                  <span className="text-[var(--color-ink)] font-mono font-bold text-[10px] truncate">{r.other}</span>
                                  {r.weight > 1 && <span className="ml-auto text-[var(--color-neutral)] font-mono shrink-0">{r.weight}×</span>}
                                </div>
                              </button>
                            ))}
                          </div>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="h-full flex flex-col items-center justify-center gap-2 opacity-40 p-8 text-center">
                      <Network className="w-5 h-5 text-[var(--color-ink)]" />
                      <span className="text-[10px] font-mono uppercase tracking-widest text-[var(--color-neutral)]">Click any node<br />to inspect</span>
                    </div>
                  )
                )}

                {/* ── Analytics tab ───────────────────────────────── */}
                {rightPanel === "stats" && (
                  statsLoading ? (
                    <div className="h-full flex items-center justify-center">
                      <div className="w-6 h-6 border-2 border-[var(--color-rule)] border-t-[var(--color-ink)] rounded-none animate-spin" />
                    </div>
                  ) : !stats ? (
                    <div className="h-full flex flex-col items-center justify-center gap-2 opacity-40 p-8 text-center">
                      <BarChart2 className="w-6 h-6 text-[var(--color-ink)]" />
                      <span className="text-[10px] font-mono uppercase tracking-widest text-[var(--color-neutral)]">No stats available</span>
                    </div>
                  ) : (
                    <div className="p-4 space-y-6 text-xs">
                      <div className="grid grid-cols-2 gap-3">
                        {[{ label: "Entities", value: stats.nodeCount }, { label: "Relations", value: stats.linkCount }].map(({ label, value }) => (
                          <div key={label} className="rounded-none bg-[var(--color-paper-2)] border-[1px] border-[var(--color-rule)] border-solid p-3.5">
                            <div className="text-2xl font-bold font-mono text-[var(--color-ink)] tabular-nums">{value.toLocaleString()}</div>
                            <div className="text-[var(--color-neutral)] font-mono uppercase tracking-widest text-[9px] font-bold mt-1">{label}</div>
                          </div>
                        ))}
                      </div>

                      <div>
                        <div className="text-[var(--color-neutral)] font-mono uppercase tracking-widest font-bold mb-2">Entity Types</div>
                        <div className="space-y-2">
                          {stats.typeDistribution.map(({ type, count }) => {
                            const pct = Math.round((count / Math.max(stats.nodeCount, 1)) * 100);
                            return (
                              <div key={type} className="bg-[var(--color-paper-2)] border-[1px] border-[var(--color-rule)] border-solid p-2">
                                <div className="flex justify-between mb-1">
                                  <span className="flex items-center gap-2">
                                    <span className="w-2.5 h-2.5 rounded-none border-[1px] border-[var(--color-rule)] border-solid" style={{ background: TYPE_DOT_COLOR(type) }} />
                                    <span className="text-[var(--color-ink)] font-mono font-bold text-[10px] uppercase">{type}</span>
                                  </span>
                                  <span className="text-[var(--color-neutral)] font-mono font-bold tabular-nums">{count}</span>
                                </div>
                                <div className="h-1.5 rounded-none bg-[var(--color-paper-3)] border-[1px] border-[var(--color-rule)] border-solid overflow-hidden">
                                  <div className="h-full rounded-none transition-all" style={{ width: `${pct}%`, background: TYPE_DOT_COLOR(type) }} />
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>

                      <div>
                        <div className="text-[var(--color-neutral)] font-mono uppercase tracking-widest font-bold mb-2">Top Entities by Degree</div>
                        <div className="space-y-1.5">
                          {stats.topEntities.map(({ name, type, degree }) => (
                            <button key={name} onClick={() => handleNodeClick({ id: name })}
                              className="w-full flex items-center justify-between px-3 py-2.5 rounded-none bg-[var(--color-paper-2)] border-[1px] border-[var(--color-rule)] border-solid hover:bg-[var(--color-paper-3)] transition-colors group cursor-pointer text-left">
                              <span className="flex items-center gap-2 min-w-0">
                                <span className="w-2.5 h-2.5 rounded-none border-[1px] border-[var(--color-rule)] border-solid shrink-0" style={{ background: TYPE_DOT_COLOR(type) }} />
                                <span className="text-[var(--color-ink)] font-bold font-mono text-[10px] truncate">{name}</span>
                              </span>
                              <span className="text-[var(--color-neutral)] font-mono text-[9px] uppercase font-bold tabular-nums shrink-0 ml-2">{degree} links</span>
                            </button>
                          ))}
                        </div>
                      </div>

                      <div>
                        <div className="text-[var(--color-neutral)] font-mono uppercase tracking-widest font-bold mb-2">Common Relations</div>
                        <div className="space-y-1">
                          {stats.topRelationTypes.map(({ type, count }) => (
                            <div key={type} className="flex items-center justify-between px-3 py-2 rounded-none bg-[var(--color-paper-2)] border-[1px] border-[var(--color-rule)] border-solid text-[10px] font-mono font-bold text-[var(--color-ink)]">
                              <span className="truncate">{type}</span>
                              <span className="text-[var(--color-neutral)] tabular-nums shrink-0 ml-2">{count}×</span>
                            </div>
                          ))}
                        </div>
                      </div>

                      <div>
                        <div className="text-[var(--color-neutral)] font-mono uppercase tracking-widest font-bold mb-2">Relations per Document</div>
                        <div className="space-y-1">
                          {stats.docContributions.map(({ doc, count }) => (
                            <div key={doc} className="flex items-center justify-between px-3 py-2 rounded-none bg-[var(--color-paper-2)] border-[1px] border-[var(--color-rule)] border-solid text-[10px] font-mono text-[var(--color-ink)]">
                              <span className="truncate text-[9px] font-mono">{doc}</span>
                              <span className="text-[var(--color-neutral)] font-bold tabular-nums shrink-0 ml-2">{count}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  )
                )}

              </div>
            </motion.aside>
          )}
        </AnimatePresence>
      </section>
    </div>
  );
}
