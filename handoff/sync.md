# 🔄 Antigravity & Claude Code: Sync Board

This file is the single source of truth for the division of labor between Claude Code (Frontend UI) and Antigravity (Backend APIs).

## 📂 Strict Folder Ownership
To avoid Git conflicts and hallucinations, do not edit files outside your assigned domains.

### 🎨 Claude Code's Domain (Frontend & UI)
* `web/src/app/(auth)/*` - Login/Signup screens
* `web/src/app/(dashboard)/*` - Main application UI
* `web/src/components/*` - React components (Dropzones, Chat bubbles, Force Graphs)
* `web/src/app/globals.css` - Tailwind CSS styles

### ⚙️ Antigravity's Domain (Backend & Data)
* `web/src/app/api/*` - Next.js serverless routes
* `web/src/lib/neo4j/` - Neo4j drivers and Cypher queries
* `web/src/lib/inngest/` - Background worker functions
* `web/src/lib/supabase/` - Database schemas and RLS setup

---

## 📋 Task Board & Backlog

### Task #2 for Claude Code (Supabase Auth UI)
**Status:** 🟢 DONE
**Notes:**
- `@supabase/supabase-js` and `@supabase/ssr` were already installed.
- Scaffolded `(auth)/login/page.tsx` and `(auth)/signup/page.tsx` using the Hallmark Quiet design system (light modern-minimal — the landing page was redesigned from dark glassmorphism to light during Task #1 redo).
- Added `web/src/lib/supabase/browser-client.ts` using `createBrowserClient` from `@supabase/ssr`.
- Login: `signInWithPassword` → redirects to `/upload`. Signup: `signUp` with email redirect → confirmation screen.
- Nav links in `page.tsx` updated to Next.js `<Link>` components.

### Task #3 for Claude Code (The Upload UI)
**Status:** 🟢 DONE
**Notes:**
- Created `(dashboard)/upload/page.tsx` — auth-guarded (redirects to `/login` if no session).
- `UploadDropzone.onFilesSelected` wired: uploads each file to Supabase Storage bucket `documents` at path `{user_id}/{timestamp}-{filename}`, then POSTs `{ file_url, filename }` to `/api/upload`.
- Per-file status strip below the dropzone (busy / done / error states).
- Dashboard topbar: wordmark + Chat link + Sign out.

### Task #4 for Claude Code (The Chat & Graph UI)
**Status:** 🟢 DONE
**Notes:**
- Installed `react-force-graph-2d`.
- Created `(dashboard)/chat/page.tsx` — auth-guarded split-screen: 380 px chat panel left, force-graph canvas right.
- Created `components/ForceGraph.tsx` — dynamically imported (`ssr: false`) to avoid canvas/window SSR issues. Shows empty state SVG when no graph data, then renders nodes+edges with directional arrows when data arrives.
- Chat: Enter sends, Shift+Enter newline, auto-growing textarea, auto-scroll to latest message. POSTs `{ message, history }` to `/api/chat`, reads `{ answer, graph }` from response.
- Graph label ("KNOWLEDGE GRAPH") absolute-positioned in top-left of canvas.
- `react-force-graph-2d` contract: `{ nodes: [{ id, name }], links: [{ source, target, label? }] }`.

**Waiting on Antigravity:** `/api/upload` and `/api/chat` route implementations.

---
## ✅ Completed Tasks
- **Task #1 (UI Foundation — redo):** Hallmark redesign of landing page. Narrative Workflow macrostructure, Quiet theme (light modern-minimal), OKLCH token system, JetBrains Mono display + Geist body. Files: `tokens.css`, `globals.css`, `layout.tsx`, `page.tsx`.
- **Task #1 (Backend Foundation):** Antigravity initialized Next.js, defined the subagent personas, and established the Handoff protocol.
- **Task #2 (Frontend Auth UI):** Login + signup pages with Supabase `signInWithPassword` / `signUp`. Browser client via `@supabase/ssr`. Nav upgraded to Next.js `<Link>`.
- **Task #2 (Backend Security):** Antigravity Security-DBA wrote the strict Supabase SQL schemas and RLS multi-tenant policies.
- **Task #3 (Upload UI):** Dashboard upload page — auth-guarded, wired to Supabase Storage + `/api/upload`.
- **Task #4 (Chat + Graph UI):** Split-screen chat page + `ForceGraph` component (`react-force-graph-2d`, SSR-safe).
