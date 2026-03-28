# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # Start dev server (tsx watch server.ts + Vite HMR)
npm run build        # Production build → build/client/ + build/server/
npm start            # Run production build (set NODE_ENV=production)
npm run typecheck    # tsc --noEmit

npm run db:generate  # Generate SQL migration from schema changes
npm run db:migrate   # Apply pending migrations to aisight.db
npm run db:studio    # Open Drizzle Studio (web DB inspector)
```

Migrations run automatically on dev server startup. After changing `app/lib/db/schema.ts`, always run `db:generate` then `db:migrate`.

## Architecture

**Runtime:** React Router v7 (`@react-router/*`) + Express (`server.ts`). This is **not** Next.js — do not use any `next/*` imports, `"use client"`, `"use server"`, or Next.js routing conventions.

**Single process:** Express + React Router runs in one Node.js process. This is intentional — it allows `better-sqlite3` (synchronous), Playwright browser singleton, and the in-process SSE EventEmitter to coexist safely.

### Request flow

```
HTTP → Express (server.ts)
         ├── pino-http logging
         ├── compression
         ├── Vite dev middleware (dev) / static build/client/ (prod)
         └── createRequestHandler → React Router
                  ├── Loaders (server-side data fetch)
                  ├── Actions (mutations via form POST)
                  └── Resource routes (API — no default export)
```

### Route conventions

- **Page routes** (`app/routes/*.tsx`): export `loader`, `action`, and a default React component.
- **Resource routes** (`app/routes/api.*.ts`): export `loader` and/or `action` only — **no default export**.
- **Route config** is explicit in `app/routes.ts` — file-based discovery is disabled.
- Path alias `~/` maps to `app/`.

### Pipeline architecture (three-tier scraping)

```
User query → POST /api/crawl → orchestrator.ts (background, non-blocking)
  1. Tavily search (raw_content if ≥200 chars)
  2. HTTP + @mozilla/readability (if Tavily insufficient)
  3. Playwright CDP (fallback for JS-rendered / paywalled pages)
  → geminiExtract.ts (Gemini Flash) → stores to SQLite
  → pipelineEmitter.emit(sessionId, event)
       ↓
GET /api/chat/:sessionId → SSE ReadableStream → client EventSource
```

The `pipelineEmitter` (`app/lib/sse/emitter.ts`) is the single in-process EventEmitter connecting the pipeline to SSE responses. All pipeline events (`progress`, `article`, `entity`, `complete`, `error`) flow through it.

### LLM tiers

- **Tier 1 — `gemini-2.5-flash-lite`**: entity/event/risk extraction from individual articles (`geminiExtract.ts → extractFromArticle`). Active `extractionItems` rows are loaded from DB and injected into the prompt dynamically. Extraction output includes `eventType` (e.g. `regulation`, `enforcement`, `earnings`, `risk_event`).
- **Tier 2 — `gemini-3-flash-preview`**: cross-article synthesis, complex reasoning (`geminiExtract.ts → reasonAcrossArticles`), and graph chat Q&A (`api.graph.chat.ts`).

### Database (SQLite + Drizzle ORM)

Schema lives in `app/lib/db/schema.ts`. DB singleton in `app/lib/db/client.ts` (`getDb()`). All tables use `nanoid()` string PKs.

Key table groups:
- **Content**: `articles`, `entities`, `articleEntities`, `relationships`, `events`, `riskSignals`, `eventExtractionItems`
- **Pipeline state**: `pipelineRuns`, `pipelineItems` (replaces any memory.md approach)
- **Config**: `sectors`, `fiscalCalendars`, `extractionItems`
- **Chat**: `chatSessions`, `chatMessages`

### Fiscal calendar system

Dates are always stored as absolute ISO timestamps. Fiscal quarter mapping is **presentation-layer only** — computed at query time in `app/lib/fiscal/quarters.ts`. The dashboard passes entity + quarter + year → `getFiscalQuartersForYear()` → date range → SQL filter.

### Cytoscape.js (graph page)

Cytoscape accesses `window`/`document` on import and cannot run server-side. It is loaded via `import("cytoscape")` inside a `useEffect` in `app/routes/graph.tsx`. A `mounted` state gate ensures the container div exists before initialisation.

### Graph page layout

The graph page (`app/routes/graph.tsx`) uses a two-column layout:
- **Left**: Cytoscape canvas (fills all remaining space), with a collapsible `Legend` overlay in the bottom-left corner.
- **Right sidebar** (320 px, collapsible via header button): stacks `NodeDetail` (shown on node click) above `ChatPanel` (LLM chat).

The `GraphCanvas` component exposes a `cyInstanceRef` prop so the parent page can call Cytoscape methods (e.g. highlight nodes returned by the graph chat).

### Graph chat (`/api/graph/chat`)

`POST /api/graph/chat` — resource route (`app/routes/api.graph.chat.ts`). Accepts `{ question, enableWebSearch }`. Pipeline:
1. Keyword-matches entities by name in the DB.
2. Fetches related relationships, events (via `articleEntities`), and risk signals.
3. Optionally calls Tavily for live web search enrichment (only if `TAVILY_API_KEY` is set and `enableWebSearch: true`).
4. Calls Gemini Tier 2 with the assembled context.
5. Returns `{ answer, context: { counts }, highlightEntityIds, highlightEventIds }`.

The frontend uses `highlightEntityIds` / `highlightEventIds` to add a yellow `.highlighted` CSS class to matched Cytoscape nodes.

### Knowledge graph data model

The graph has two node types and two edge types:

| Type | Shape | Colour source | DB table |
|------|-------|---------------|----------|
| Entity node | Circle | `type` field (company/regulator/person/instrument) | `entities` |
| Event node | Diamond | `eventType` field (regulation/enforcement/earnings/…) | `events` |
| Entity↔Entity edge | Solid line | — | `relationships` |
| Entity↔Event edge | Dashed line | — | Derived: `articleEntities` + `events` sharing same `articleId` |

### Pipeline enrichments (recent)

- `orchestrator.ts` builds an `entityIdMap` during the entity upsert loop and links `riskSignals.entityId` to the primary extracted entity.
- `geminiExtract.ts` prompt now requests `eventType` in the JSON output; `orchestrator.ts` stores it on the `events` row.

### Key files

| File | Purpose |
|------|---------|
| `server.ts` | Express entry — runs migrations, starts Vite/static middleware, mounts React Router |
| `app/routes.ts` | Explicit route config (all routes declared here) |
| `app/lib/db/schema.ts` | Single source of truth for all DB tables |
| `app/lib/pipeline/orchestrator.ts` | Pipeline coordinator — call `runPipeline()` to trigger a scrape |
| `app/lib/sse/emitter.ts` | In-process EventEmitter singleton for SSE |
| `app/lib/pipeline/geminiExtract.ts` | LLM extraction — both tiers |
| `app/routes/graph.tsx` | Knowledge graph page — Cytoscape, chat panel, node detail, legend |
| `app/routes/api.graph.ts` | Graph data API — entities + events + derived involvement edges |
| `app/routes/api.graph.chat.ts` | Graph chat API — keyword search + Gemini Q&A + optional Tavily web search |
